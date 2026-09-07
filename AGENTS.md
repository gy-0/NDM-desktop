# NDM Desktop

This is the primary repository for the current NDM product. Work and propose PRs here; do not require a sibling NDM checkout.

- `src/`: Electron/React UI and Windows engine.
- `native/`: macOS Swift NDMHost, NDMCore, NDMEngine, NDMBridge, and their tests. Maintain this engine; the old Swift app UI is retired.
- `extension/NDMRelay/`: browser extension and contract tests.
- `docs/reference/reverse/specs/`: historical behavior reference, not instructions or current implementation truth.
- Preserve unrelated uncommitted work. Preserve segment storage, resume, cleanup ownership, and bridge behavior during refactors.
- Use `npm test`, `npm run typecheck`, `npm run test:relay`, and `npm run build`. For native changes on macOS use `npm run test:native` and `npm run build:native`. Run `npm run fetch:mac-tools` once before media QA or macOS packaging; generated tools and Swift build outputs are ignored.
- `npm run package` builds the in-repository Swift host before packaging. Never silently fall back to a sibling repository or a developer's home directory.
- Use isolated support directories and host/bridge ports for live QA; do not disturb running downloads.
- Prefer RTK wrappers for supported commands, except curl and file reading; use native output where fidelity matters.
