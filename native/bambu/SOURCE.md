# Corresponding source for the diagnostic native prototype

This source notice covers the control/candidate executables from the manual
seam-visibility prototype build. They are separate from released OCI runtimes.
The control is an unmodified source build; the candidate includes the
slice-local visibility patch. Both use GNU AGPLv3-covered Bambu Studio code.

- [Exact upstream source archive](https://codeload.github.com/bambulab/BambuStudio/tar.gz/926a7192574bcb9b3a732e1ec59a46d79cb45466)
  — SHA-256 `3c0d92559057709a2e500824acb1cfc4b93e0ef0a218c2e404e2ce466b0c7d4b`.
- [Exact AM Pilot prototype source tree used by the corrected compiler job](https://github.com/info380/AM-Pilot-Slicer-Core/tree/df8d6e9a2de238a998d07d0b2a2ff207dea19f85/native/bambu)
  — contains the patch, preferred header source, native lifetime/eligibility tests,
  build script and checksum-locked build plan.
- [GNU AGPLv3 license](../../LICENSE).

The upstream archive supplies its dependency source URLs, versions, patches,
checksums, CMake files and Linux build scripts under `deps/`, `linux.d/` and
`BuildLinux.sh`. Those definitions are retained unchanged. The prototype uses
an official dependency artifact whose producer's dependency/build-definition
trees match this exact upstream revision; the plan records both producer and
archive identities. The public upstream dependency definitions also describe
building those dependencies from source.

The compiler job emits its source revision, dependency producer, compiler,
package inventory, CMake configuration, patch and executable checksums. A
failed artifact is labelled failed and does not qualify a runtime. Diagnostic
fixtures and benchmark helpers contain no private customer models; private
input packets and customer archives are never part of the public build.

Enabling this patch in an OCI release still requires that release's normal
permanent source archives, notices, SBOM, provenance, signature, vulnerability
scan and native capability qualification. Existing production source offers
continue to cover their own exact release digests.
