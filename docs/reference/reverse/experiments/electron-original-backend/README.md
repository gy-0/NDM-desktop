# Deferred original-engine backend experiment

The product goal is to improve the existing Electron NDM download experience to
match or exceed the original, using measured comparisons. Replacing the existing
macOS Swift engine is not the default objective.

This archive preserves the unfinished opt-in Electron routing experiment as of
2026-10-05. The integration patch and two disabled sources are research material,
not active product code. Typecheck, tests and build passed before archival, but
the real Electron integration was not run and is not claimed verified.

The active EngineClient routing and quit flow were restored to their prior state.
Previously verified original-engine research controllers remain available for
comparative measurements. Future engine reuse decisions require evidence of
experience/performance benefits over the current implementation.
