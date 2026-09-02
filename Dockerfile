# syntax=docker/dockerfile:1.7

ARG DEBIAN_BUILD_IMAGE=debian:bookworm-20250811-slim@sha256:b1a741487078b369e78119849663d7f1a5341ef2768798f7b7406c4240f86aef
ARG NODE_RUNTIME_IMAGE=node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e

FROM ${DEBIAN_BUILD_IMAGE} AS prusa-build

ARG PRUSA_SLICER_COMMIT=f1776c0a6347bb84986d10eac8db1021f5bd8548
ARG PRUSA_SLICER_SOURCE_SHA256=fe6c6696360c688f3ac6744964d5c27d98394da3e3cd00a8b8df7bc3fd4f7055
ARG GMP_VERSION=6.2.1
ARG GMP_SOURCE_SHA256=eae9326beb4158c386e39a356818031bd28f3124cf915f8c5b1dc4c7a36b4d7c
ARG DEBIAN_SNAPSHOT=20250811T000000Z

# Boost contains Unicode pathnames. Keep CMake/libarchive on Debian's built-in
# UTF-8 locale so dependency extraction is deterministic on headless builders.
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN printf '%s\n' \
      "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} bookworm main" \
      "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT} bookworm-security main" \
      > /etc/apt/sources.list \
    && rm -f /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      autoconf \
      automake \
      build-essential \
      ca-certificates \
      cmake \
      curl \
      gettext \
      git \
      libdbus-1-dev \
      libglu1-mesa-dev \
      libgtk-3-dev \
      libtool \
      libwebkit2gtk-4.1-dev \
      m4 \
      ninja-build \
      pkg-config \
      texinfo \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN curl --fail --location --proto '=https' --tlsv1.2 \
      "https://codeload.github.com/prusa3d/PrusaSlicer/tar.gz/${PRUSA_SLICER_COMMIT}" \
      --output /tmp/prusaslicer.tar.gz \
    && echo "${PRUSA_SLICER_SOURCE_SHA256}  /tmp/prusaslicer.tar.gz" | sha256sum --check --strict \
    && tar --extract --gzip --file /tmp/prusaslicer.tar.gz --strip-components=1 \
    && rm /tmp/prusaslicer.tar.gz

# PrusaSlicer 2.9.3 points GMP at gmplib.org, which repeatedly times out from
# GitHub-hosted runners. Preseed the same checksum-locked archive from GNU's
# authoritative distribution host; ExternalProject verifies it again.
RUN mkdir -p deps/.pkg_cache/GMP \
    && curl --fail --location --retry 5 --retry-all-errors --retry-delay 2 \
      --proto '=https' --tlsv1.2 \
      "https://ftp.gnu.org/gnu/gmp/gmp-${GMP_VERSION}.tar.bz2" \
      --output "deps/.pkg_cache/GMP/gmp-${GMP_VERSION}.tar.bz2" \
    && echo "${GMP_SOURCE_SHA256}  deps/.pkg_cache/GMP/gmp-${GMP_VERSION}.tar.bz2" \
      | sha256sum --check --strict

# Prusa's supported Linux build path compiles the pinned dependency bundle first.
# The no-OCCT preset intentionally excludes STEP import; AM Pilot protocol v1 accepts STL and 3MF.
RUN cmake --preset no-occt -S deps \
    && cmake --build deps/build-no-occt --parallel 2

RUN cmake -S . -B build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX=/opt/prusa \
      -DCMAKE_PREFIX_PATH=/src/deps/build-no-occt/destdir/usr/local \
      -DSLIC3R_BUILD_TESTS=OFF \
      -DSLIC3R_DESKTOP_INTEGRATION=OFF \
      -DSLIC3R_ENABLE_FORMAT_STEP=OFF \
      -DSLIC3R_FHS=ON \
      -DSLIC3R_GUI=OFF \
      -DSLIC3R_PCH=OFF \
      -DSLIC3R_STATIC=ON \
    && cmake --build build --parallel 2 \
    && cmake --install build \
    && strip /opt/prusa/bin/prusa-slicer \
    && mkdir -p /opt/prusa/lib \
    && find /src/deps/build-no-occt/destdir/usr/local/lib \
      \( -type f -o -type l \) -name '*.so*' \
      -exec cp -a -t /opt/prusa/lib {} + \
    && LD_LIBRARY_PATH=/opt/prusa/lib ldd /opt/prusa/bin/prusa-slicer \
      | tee /tmp/prusa-slicer-ldd.txt \
    && ! grep -F 'not found' /tmp/prusa-slicer-ldd.txt \
    && LD_LIBRARY_PATH=/opt/prusa/lib /opt/prusa/bin/prusa-slicer --version \
      | grep -F '2.9.3'

FROM ${NODE_RUNTIME_IMAGE} AS worker-dependencies
WORKDIR /worker
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev \
    && npm cache clean --force

FROM ${NODE_RUNTIME_IMAGE} AS runtime

LABEL org.opencontainers.image.title="AM Pilot Slicer Core Worker" \
      org.opencontainers.image.description="Headless PrusaSlicer worker for the AM Pilot Slicer protocol" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/info380/AM-Pilot-Slicer-Core" \
      org.opencontainers.image.version="0.1.6" \
      org.opencontainers.image.prusaslicer.version="2.9.3" \
      org.opencontainers.image.prusaslicer.revision="f1776c0a6347bb84986d10eac8db1021f5bd8548"

ENV NODE_ENV=production \
    LD_LIBRARY_PATH=/opt/prusa/lib \
    PRUSA_SLICER_CMD=/opt/prusa/bin/prusa-slicer \
    SLICER_WORK_ROOT=/tmp/am-pilot-slicer-worker

COPY --from=prusa-build /opt/prusa /opt/prusa
WORKDIR /worker
COPY --from=worker-dependencies /worker/node_modules ./node_modules
COPY package.json ./
COPY src ./src

RUN ldd /opt/prusa/bin/prusa-slicer | tee /tmp/prusa-slicer-ldd.txt \
    && ! grep -F 'not found' /tmp/prusa-slicer-ldd.txt \
    && /opt/prusa/bin/prusa-slicer --version | grep -F '2.9.3' \
    && mkdir -p /tmp/am-pilot-slicer-worker \
    && chown -R node:node /tmp/am-pilot-slicer-worker /worker

USER node
STOPSIGNAL SIGTERM
CMD ["node", "src/index.js"]
