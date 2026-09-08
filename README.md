# make-runner-mcp

> **Disclaimer — read before using.** This is a personal convenience tool
> for running `make` commands in *your own* projects through an AI coding
> agent, built to narrow what that agent can do compared to raw shell or
> Docker socket access. **It is not a hardened security boundary, it has
> not been independently audited, and it is not a substitute for actually
> reviewing what's in your Makefile.** Don't use it in any context where
> the blast radius of a mistake matters — shared infrastructure,
> production systems, other people's data, or anywhere you wouldn't
> already trust the Makefile itself to be run unattended. See
> ["Risks and limitations"](#risks-and-limitations) below before relying
> on it for anything beyond that.

Scoped MCP server that discovers a project's Makefile targets and exposes
each one as an individual MCP tool. No free-form shell/docker access is
ever given to the model — only targets that literally exist in the
project's own Makefile, minus anything hard-denied (deploy/destroy/prod/
publish/release) or excluded via `.mcp-make-config.json`.

## Install

Nothing to install ahead of time for end users — each client config below
runs the server straight from this GitHub repo via `npx`, pinned to a
release tag. `npx` fetches and caches it on first use.

To work on the server itself (e.g. to run it locally or through the
inspector below):

```bash
npm install
```

## Two ways to run this — pick based on whether your agent is sandboxed

**`MCP_TRANSPORT=http` is the default.** This is a breaking change from
earlier versions, which defaulted to `stdio`: a client config that spawns
this as a subprocess expecting a stdio handshake (the old default) now
needs `MCP_TRANSPORT: "stdio"` added to its `env` block explicitly, or
it'll get an HTTP server trying to bind a port instead of speaking MCP
over its own stdin/stdout.

- **`stdio` (opt-in)** — the client spawns this as a subprocess and speaks
  MCP over its stdin/stdout. Simplest option: no port, no token, no
  process to manage yourself. Use this for direct, unsandboxed use — an
  agent running with normal access to your machine. See
  [Client configs (stdio)](#client-configs-stdio) below.
- **`http` (default)** — this runs as its own persistent process, with
  clients connecting to it over the network instead of spawning it. Use
  this when the calling agent runs inside its own sandbox (e.g. Gemini
  CLI's `--sandbox`): a sandboxed agent that spawns an MCP server via
  `stdio` spawns it *inside its own sandbox container*, which means the
  server (and anything it shells out to, e.g. `docker`) only has whatever
  access that container has — typically none, and giving it more (like a
  mounted Docker socket) hands that same access to the agent's own native
  shell tool too, since the sandbox isn't scoped per-tool. Running this
  server outside the sandbox instead, reached only over the network, means
  the sandbox never needs Docker access at all — only this server does,
  and it only ever runs the target you named. See
  [Running as a persistent HTTP server](#running-as-a-persistent-http-server-for-a-sandboxed-agent)
  below — this is a real, verified pattern, not a theoretical one.

## Verify it works standalone

```bash
MCP_TRANSPORT=stdio npx @modelcontextprotocol/inspector node server.js
```

This opens a local UI to list tools and call them directly, useful for
confirming the Makefile parsing looks right before wiring it into an agent.

## Client configs (stdio)

The server is the same everywhere — only the config file and its shape
differ per client. Things that change between projects/teams:

- `PROJECT_DIR` — the target project's root.
- `#v1.0.1` — bump this to whatever tag you've actually released. Always
  pin to a release tag, never `#main`: for a tool that executes commands,
  an unpinned branch reference means a bad push could silently change what
  runs on everyone's machine.
- `MCP_TRANSPORT: "stdio"` — required in every block below, since `http`
  is now the default and a stdio-spawned subprocess needs to opt back in
  explicitly.

### Gemini CLI
`.gemini/settings.json` (project) or `~/.gemini/settings.json` (user-wide):
```json
{
  "mcpServers": {
    "makeRunner": {
      "command": "npx",
      "args": ["-y", "github:davindermahal/make-runner-mcp#v1.0.1"],
      "env": { "PROJECT_DIR": "/path/to/project", "MCP_TRANSPORT": "stdio" }
    }
  }
}
```

### Claude Code
Project-level `.mcp.json` at the repo root (checked in, shared with the team):
```json
{
  "mcpServers": {
    "makeRunner": {
      "command": "npx",
      "args": ["-y", "github:davindermahal/make-runner-mcp#v1.0.1"],
      "env": { "PROJECT_DIR": "/path/to/project", "MCP_TRANSPORT": "stdio" }
    }
  }
}
```
Or via the CLI: `claude mcp add makeRunner -e PROJECT_DIR=/path/to/project -e MCP_TRANSPORT=stdio -- npx -y github:davindermahal/make-runner-mcp#v1.0.1`

### Claude Desktop
`claude_desktop_config.json` (Settings → Developer → Edit Config):
```json
{
  "mcpServers": {
    "makeRunner": {
      "command": "npx",
      "args": ["-y", "github:davindermahal/make-runner-mcp#v1.0.1"],
      "env": { "PROJECT_DIR": "/path/to/project", "MCP_TRANSPORT": "stdio" }
    }
  }
}
```

### Cursor
`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):
```json
{
  "mcpServers": {
    "makeRunner": {
      "command": "npx",
      "args": ["-y", "github:davindermahal/make-runner-mcp#v1.0.1"],
      "env": { "PROJECT_DIR": "/path/to/project", "MCP_TRANSPORT": "stdio" }
    }
  }
}
```

### Any other MCP-compatible client
All of these follow the same `command` / `args` / `env` shape because it's
part of the MCP spec's stdio transport — if a client supports MCP at all,
this same block (adjusted to that client's config file location, with
`MCP_TRANSPORT: "stdio"` added to `env`) will work without touching the
server itself.

## Running as a persistent HTTP server (for a sandboxed agent)

Verified end to end against a real sandboxed `gemini --sandbox` session
driving a real Docker-based project (PHPUnit and Composer both ran inside
the project's container, through this server, with the sandbox itself
having no `docker` CLI or socket at all — the model's own native shell
tool inside that same session had zero Docker access, confirmed with
`which docker` returning nothing).

**1. Run the server as its own process**, outside any sandbox, with
normal access to whatever the project's targets need (Docker included —
nothing special, just however you'd normally run `docker`/`docker compose`
on this machine):

```bash
PROJECT_DIR=/path/to/project \
MCP_HTTP_TOKEN=$(openssl rand -hex 24) \
MCP_HTTP_PORT=8791 \
npx -y github:davindermahal/make-runner-mcp#v1.0.1
```

Generate a real random token (`openssl rand -hex 24` or equivalent) and
keep it — the server refuses to start without one (fails closed, not
silently unauthenticated), and every client needs it to connect. Keep
this process running for as long as you want the tool available; it's not
spawned per-client the way `stdio` mode is.

**2. Point the client at it over the network, not a subprocess spawn.**
For a client whose agent itself runs sandboxed (Gemini's `--sandbox`,
which auto-maps `host.docker.internal` to the host — verified live, zero
extra network config needed), use that hostname so the sandboxed process
can reach a server running on the host:

```json
{
  "mcpServers": {
    "makeRunner": {
      "url": "http://host.docker.internal:8791/mcp",
      "type": "http",
      "headers": { "Authorization": "Bearer <the token from step 1>" }
    }
  }
}
```

For an unsandboxed client on the same machine as the server, `127.0.0.1`
works the same as any other local service.

**Security notes specific to this mode** (also see
[Risks and limitations](#risks-and-limitations)):

- `MCP_HTTP_HOST` defaults to `0.0.0.0` — reachable from your local
  network, not just the sandbox, unless your host firewall restricts it.
  The bearer token is the actual access control; treat it like any other
  credential (don't commit it, don't reuse it across machines/projects).
- Every project you run this way needs its own token and, generally, its
  own port — there's no per-project isolation beyond that; anyone who has
  the token for a given running instance can call any tool it exposes.

## Publishing to npm instead

Shipping via GitHub tags (above) is the default — it's a public repo, so
`npx github:...` works with zero auth setup on any teammate's machine, and
tagging releases keeps updates a deliberate, visible choice rather than
whatever `main` happens to be. Publishing to npm is a possible later step
(marginally faster resolution, no GitHub dependency) but isn't required to
ship this:

```bash
npm publish            # or: npm publish --registry <your-private-registry>
```

Once published, every config above can drop the `github:...#tag` args
entry in favor of `["-y", "make-runner-mcp"]` (add `@<version>` to pin,
same reasoning as pinning the GitHub tag).

## Passing arguments through to a target

Extra `args` on a tool call may only be `make` flags (from a small safe
allowlist — `-n`, `-k`, `-s`, etc.) or `VAR=value` assignments. Bare
positional arguments (e.g. an extra target name, or a package name/flag
with no `VAR=` in front of it) are always rejected — `make` treats a bare
trailing word as an *additional build goal*, not data, so allowing them
would let a call to one target silently smuggle a second, possibly-denied
target onto the same invocation.

For a target whose underlying command takes its own arguments (`composer
install <pkg> --no-dev`, `npm run <script> -- <flags>`, etc.), have its
recipe read a single variable and pass one `VAR=value` pair at call time:

```makefile
composer: ## Run composer inside the app container, e.g. ARGS="install symfony/console --no-dev"
	docker compose exec app composer $(ARGS)
```

Called with `args: ["ARGS=install symfony/console --no-dev"]`. The value
half of a `VAR=value` pair is checked against a more permissive (but still
shell-metacharacter-free) pattern than other arguments specifically to
support this — letters, digits, spaces, and typical package-name/version/
flag punctuation are allowed; shell control characters (`; & | $ \` ' " < >
( ) # \ * ? [ ]`, newlines) are not, since `make` ultimately splices this
value into a recipe line that runs through a real shell.

This keeps the "one call always executes exactly the target it names, in
addition to whatever its own vetted recipe does with `$(ARGS)`" guarantee
intact — the passthrough content is only ever data to the recipe you
already wrote, never a way to select a different target.

If a project's Makefile currently relies on `$(MAKECMDGOALS)` or a similar
bare-word passthrough trick (common for wrapping tools like composer/npm),
see [`MAKEFILE-GUIDE.md`](./MAKEFILE-GUIDE.md) — a self-contained guide
written to be handed directly to an AI coding agent, with instructions to
find and convert those targets to the `ARGS` pattern above.

## Per-project overrides

Drop an optional `.mcp-make-config.json` in a project's root to narrow
which targets are exposed beyond the built-in denylist, and/or restrict
which environment variables `make` runs with:

```json
{
  "deny": ["clean-volumes", "seed-prod"],
  "allow": null,
  "envAllowlist": null
}
```

`allow`, if set, becomes an explicit whitelist — only those exact target
names are ever exposed, regardless of what else is in the Makefile.

`envAllowlist`, if set, restricts the environment `make` (and everything
its recipes run) sees to just those variable names — useful since by
default the child process inherits this MCP server's *entire* environment,
which in an agent sandbox often includes API keys or tokens that would
otherwise be readable, and potentially echoable back into the tool result,
by any recipe. Leave it unset (the default) for unrestricted passthrough,
matching prior behavior.

A config file that fails to parse, or has an `allow`/`envAllowlist` entry
that isn't a plain array of strings, fails closed — every target is denied
(or every env var withheld) rather than silently falling back to no
restriction at all.

## Risks and limitations

**This tool reduces risk compared to giving an agent raw shell or Docker
access. It does not eliminate it, and it is not a security product.**
Read this before pointing it at anything you'd be upset to lose or break.

- **HTTP mode opens a network port that can execute commands.** It's
  authenticated (a required bearer token, fails closed if unset) but bound
  to `0.0.0.0` by default — reachable from anything that can route to that
  port, not just your intended sandboxed agent, unless your host firewall
  restricts it. On a shared network, either firewall the port or bind
  `MCP_HTTP_HOST` more narrowly. The token is the real access control;
  don't commit it, don't log it, don't reuse one across machines/projects.
- **It's only as safe as your Makefile.** The built-in denylist blocks
  five words (`deploy`, `destroy`, `prod`, `publish`, `release`) and a
  `rm-` prefix — it does not evaluate whether a target is actually
  dangerous. If your Makefile has a target that wipes a volume, drops a
  database, or force-pushes something, and its name doesn't happen to
  contain one of those words, this tool will expose it to the agent like
  any other target. The real protection this tool provides is narrower
  than "safe by default": it's "only what's already in a file you wrote
  and can read," nothing more. Review your Makefile with that in mind —
  and use `.mcp-make-config.json`'s `deny`/`allow` to explicitly exclude
  anything you don't want an agent invoking, don't rely on the built-in
  denylist alone.
- **The `ARGS="..."` passthrough convention blocks shell injection, not
  dangerous values.** The character set allowed in a `VAR=value` pair
  stops shell metacharacters (`;`, `|`, `` ` ``, etc.) from reaching a
  recipe's shell, but it does not know what your recipe *does* with that
  value. A recipe like `rm -rf $(ARGS)` would still accept a value like
  `-R 777 /` — every one of those characters is allowed. If you write a
  target that consumes `$(ARGS)`, treat that value as agent-controlled
  input and keep the underlying command it's handed to narrow and
  low-risk (a package manager, a test runner) rather than anything
  destructive.
- **The full environment is passed through by default.** Unless you set
  `envAllowlist` in `.mcp-make-config.json`, every recipe runs with this
  server's entire environment — including any API keys or tokens present
  in the agent's sandbox. Those become readable, and potentially
  echoable back into the tool's output, by any recipe. Set
  `envAllowlist` per project if that matters to you.
- **Recipe output isn't filtered for secrets.** Whatever a target prints
  to stdout/stderr is returned to the calling agent close to verbatim
  (truncated only by size, at 200KB). If a recipe's own logs happen to
  print something sensitive, this tool won't catch or redact it.
- **Protected variables cover make's own built-ins, not
  project-specific conventions.** Overriding `PATH`, `SHELL`, and similar
  is blocked. A project-specific convention like `CC=`, `DOCKER=`, or
  `COMPOSE=` used as an executable name inside a recipe has no equivalent
  protection — there's currently no way to extend that list per project.
- **This has not been independently security-reviewed or audited.** It's
  been built and tested for one person's own use across their own
  projects, not pentested or reviewed by a third party. Read the source
  (`server.js` is a single, deliberately short file) before trusting it
  with anything you care about.
- **It's designed for a trusted human running their own projects, not for
  isolating untrusted users from each other.** There's no concept of
  per-user permissions, auditing, or multi-tenant isolation. If you need
  any of that, this isn't the right tool as-is.

If any of this is a dealbreaker for your use case, the honest fix is
either: don't expose the target in question at all (`deny`/`allow` it
out), rewrite the target's recipe to be inherently safe regardless of what
`$(ARGS)` contains, or don't use this tool for that project.

### Gemini CLI specifically — tested, not theoretical

The following was verified against a real `gemini` CLI session (transcript
inspection, not just reading the final answer), because it changes what
"safe" means for this tool with that client:

- **When make-runner-mcp fails to connect for any reason, Gemini CLI does
  not fail loudly.** It silently falls back to its own native `read_file`
  and `run_shell_command` tools and accomplishes the same task via full,
  unrestricted shell access — with no clear signal beyond a generic "MCP
  issues detected" banner that also fires for unrelated, pre-existing
  broken servers. I triggered this twice, independently: once from an
  untrusted project folder, once from an unrelated `npm` cache permission
  error inside `--sandbox`. Both times the model read the Makefile
  directly and ran the command itself, completely bypassing
  make-runner-mcp, and the final answer looked identical either way — you
  cannot tell from the response alone whether the tool boundary was
  actually enforced. **This means make-runner-mcp's guarantee only holds
  while the MCP connection is actually up; it does not degrade safely.**
- **A project folder must be in Gemini CLI's persistent trust store**
  before it will load *any* project-level `.gemini/settings.json` MCP
  servers — the `--skip-trust` CLI flag alone is not sufficient for this,
  even though it looks like it should be. Without that trust, make-runner-mcp
  is silently never loaded at all (see the point above for what happens
  next).
- **`--sandbox` mode and `stdio`-spawned Docker-based targets don't mix —
  this is exactly why `http` is now the default transport.** Gemini's
  `--sandbox` re-execs itself (and everything it spawns via `stdio`, MCP
  servers included) inside its own container. The default sandbox image
  (`gemini-cli/sandbox`) does not include the `docker` CLI at all — a
  `stdio`-spawned target that shells out to `docker`/`docker compose`
  fails with `make: docker: No such file or directory`, verified verbatim.
  The tempting-looking fix — a custom sandbox image with `docker` CLI
  installed and the host's Docker socket mounted in — doesn't actually
  preserve any scoping: Gemini's sandbox is one shared container for the
  entire session, not scoped per-tool, and the native `run_shell_command`
  fallback (previous bullet) runs inside that *same* container. Mounting
  the socket in would hand that same unrestricted native shell tool
  identical Docker access, with no separation between "the vetted make
  targets" and "whatever command the model decides to run directly" — the
  exact Docker-outside-of-Docker exposure this project exists to avoid
  (see `CLAUDE.md`).

  **The actual fix, verified end to end**: run this server in `http` mode
  (the default) *outside* the sandbox — as its own process on the host,
  with normal Docker access — and let the sandboxed session reach it only
  over the network via Gemini's auto-mapped `host.docker.internal`. The
  sandbox container itself then never has Docker access at all — no CLI,
  no socket — so there's nothing for the native shell tool to fall back
  *to*, and Docker access exists exclusively through this server's vetted
  targets. Confirmed live: `mcp_makeRunner_make__unit-test` and
  `mcp_makeRunner_make__composer` both correctly drove a real project's
  Docker container (real PHPUnit and Composer output) through a sandboxed
  session that had zero `docker` CLI of its own (`which docker` returned
  nothing in that same session). See
  [Running as a persistent HTTP server](#running-as-a-persistent-http-server-for-a-sandboxed-agent)
  above for the exact setup.
