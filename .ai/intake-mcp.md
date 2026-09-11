# Project notes for make-runner-mcp

This repo is the make-runner-mcp tool itself, not a project consumed by it —
it has no Makefile of its own. Its own dev workflow is npm/node-based, not
make-based, so the standard `make install`/`build`/`test`/`lint`/`exec`
targets don't apply here; all are declared in `.ai/intake-mcp.json`'s
`skipTargets`.

- **Install**: `npm install` (only `@modelcontextprotocol/sdk` as a
  dependency; no dev dependencies).
- **Test**: `npm test` (added for DAV-33 — runs `node --test`, which
  auto-discovers `test/**/*.test.js`). No test suite existed before DAV-33.
- **Build**: none — plain ESM, no bundling/transpilation step.
- **Lint**: none configured.

No app-specific quirks or forked bundles to note yet.
