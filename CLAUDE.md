# Project context

`make-runner-mcp` is a scoped MCP server that lets AI coding agents (Gemini
CLI, Claude Code, Cursor, etc.) run a project's `make` targets without
giving the agent general shell or Docker access.

## Why this exists

The original idea was to give an agent's sandbox direct Docker + `make`
access (mounting `/var/run/docker.sock`, Docker-out-of-Docker style). That
was flagged as a security concern: an agent that can construct arbitrary
shell/docker commands has a large blast radius, especially given
prompt-injection risk (content the agent reads could steer it into
commands nobody intended).

The fix: don't give the agent shell access at all. Instead, expose *only*
the specific operations a project's Makefile already defines, each as its
own MCP tool. The trust boundary shifts from "trust the model's judgment
about what to run" to "trust whatever the team already wrote and reviewed
into the Makefile" — the model can invoke `make test`, but it can't
construct a novel `docker run -v /:/host` command, because there is no
free-form command path into this server at all.

## How it works

- `server.js` parses the target project's `Makefile` (pointed at via the
  `PROJECT_DIR` env var) and exposes one MCP tool per discovered target.
- Self-documenting comments (`target: ## description`) become the tool's
  description, so the agent sees accurate, per-project docs automatically.
- A hard-coded denylist (`deploy`, `destroy`, `prod`, `publish`, `release`,
  `rm-`) always blocks matching target names, regardless of project config.
- Projects can add `.mcp-make-config.json` to further narrow what's exposed
  (`deny` more names, or `allow` an explicit whitelist).
- Every execution goes through `child_process.spawn` with an **argv
  array**, never a shell string — this rules out shell injection as a
  category, independent of the target/allow/deny logic.
- The Makefile and config are **re-parsed on every call**, not cached at
  startup, so a target removed from the Makefile or newly denylisted can't
  be invoked under a stale tool name.

## Distribution plan

Ship via GitHub, not npm, to start — lowest friction for the team:

- Public repo (no sensitive data in this code) so `npx github:...` works
  with zero auth setup on any teammate's machine.
- Tag releases (`v1.0.0`, `v1.1.0`, ...) rather than pointing configs at
  `main`. For a tool that executes commands, an unpinned branch reference
  means a bad push could silently change what runs on everyone's machine —
  pinning makes updates a deliberate, visible choice.
- Team config snippet points at a specific tag:
  `npx -y github:<owner>/<repo>#v1.0.0`.
- npm publishing is a possible later step (marginally faster resolution,
  no GitHub dependency) but isn't required to ship this.

## Next steps (for whoever/whatever picks this up)

1. `git init`, commit these files.
2. Create a GitHub repo (public) and push.
3. Replace the `yourorg/...` placeholders in `README.md`'s config
   snippets with the real repo path.
4. `git tag v1.0.0 && git push --tags`.
5. Share the README's config block with the team.
