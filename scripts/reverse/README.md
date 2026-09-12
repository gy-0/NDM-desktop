# Reference-only reverse engineering tools

These tools do not modify NDM product code or the installed reference app. Never
run the refinement script against the only copy of an existing Ghidra project.

1. Snapshot the user-selected app and its Info.plist; hash the universal executable.
2. Extract ARM64 with `lipo <executable> -thin arm64 -output <slice>` and hash it.
3. Copy the original Ghidra project to a new output directory. For the audited
   slice (`25031b78…cdc0c7`), run `RefineEngine.java <export-directory>` as a
   Ghidra post-script using `-process NeatDownloadManager.arm64 -noanalysis`.
   It assigns analyst names/prototypes to 20 functions and exports 32 functions
   plus their instructions. Addresses are specific to this exact binary.
   Do not apply the script to a different binary without rederiving the mapping.
4. For independent machine-code checks:

```sh
python3 -m venv /tmp/neat-reference-venv
/tmp/neat-reference-venv/bin/pip install unicorn==2.1.4
/tmp/neat-reference-venv/bin/python scripts/reverse/check-original-selectors.py /absolute/path/to/NeatDownloadManager.arm64 --output /absolute/path/to/results.json
```

The Python harness enforces the full SHA-256 before mapping the supplied Mach-O
segments. It executes three original selector functions and one original HTTP
requeue decision. It hooks resource cleanup and state publication for the latter;
this is explicitly **not** end-to-end network or application testing.

The reference report is `docs/reference/reverse/verified/README.md`. Generated
proprietary binary/pseudocode/project artifacts stay outside the product repo.
