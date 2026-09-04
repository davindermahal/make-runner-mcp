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

## Verify it works standalone

```bash
npx @modelcontextprotocol/inspector node server.js
```

This opens a local UI to list tools and call them directly, useful for
confirming the Makefile parsing looks right before wiring it into an agent.

## Client configs

The server is the same everywhere — only the config file and its shape
differ per client. Two things change between projects/teams:

- `PROJECT_DIR` — the target project's root.
- `#v1.0.0` — bump this to whatever tag you've actually released. Always
  pin to a release tag, never `#main`: for a tool that executes commands,
  an unpinned branch reference means a bad push could silently change what
  runs on everyone's machine.

### Gemini CLI
`.gemini/settings.json` (project) or `~/.gemini/settings.json` (user-wide):
```json
{
  "mcpServers": {
    "makeRunner": {
      "command": "npx",
      "args": ["-y", "github:davindermahal/make-runner-mcp#v1.0.0"],
      "env": { "PROJECT_DIR": "/path/to/project" }
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
      "args": ["-y", "github:davindermahal/make-runner-mcp#v1.0.0"],
      "env": { "PROJECT_DIR": "/path/to/project" }
    }
  }
}
```
Or via the CLI: `claude mcp add makeRunner -e PROJECT_DIR=/path/to/project -- npx -y github:davindermahal/make-runner-mcp#v1.0.0`

### Claude Desktop
`claude_desktop_config.json` (Settings → Developer → Edit Config):
```json
{
  "mcpServers": {
    "makeRunner": {
      "command": "npx",
      "args": ["-y", "github:davindermahal/make-runner-mcp#v1.0.0"],
      "env": { "PROJECT_DIR": "/path/to/project" }
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
      "args": ["-y", "github:davindermahal/make-runner-mcp#v1.0.0"],
      "env": { "PROJECT_DIR": "/path/to/project" }
    }
  }
}
```

### Any other MCP-compatible client
All of these follow the same `command` / `args` / `env` shape because it's
part of the MCP spec's stdio transport — if a client supports MCP at all,
this same block (adjusted to that client's config file location) will work
without touching the server itself.

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
