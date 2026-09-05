# Prusa Print Settings catalog

This data-only catalog enumerates all 195 controls in the Print Settings tab of
PrusaSlicer 2.9.3 (upstream commit f1776c0a6347bb84986d10eac8db1021f5bd8548).
Labels, defaults, option types, groups, limits, enumeration values and original
English help text derive from src/libslic3r/PrintConfig.cpp and
src/slic3r/GUI/Tab.cpp. No GUI implementation is included.

PrusaSlicer and this derived catalog are licensed under AGPL-3.0-or-later.
Copyright Prusa Research, Alessandro Ranellucci and contributors. See LICENSE
and THIRD_PARTY_NOTICES.md for license and the exact corresponding source archive.
The generator verifies both input file checksums and fails on incomplete extraction.

Reproduce with:

    node scripts/extract-print-settings.js /path/to/PrusaSlicer/src

The output must match prusa-print-settings-2.9.3.json byte for byte. The Admin
consumer preserves these records in its attributed data module and applies its
own explicit hosted capability restrictions; this catalog is not permission to
execute desktop scripts or bypass worker qualification. This metadata addition
does not change the worker executable or qualified image.
