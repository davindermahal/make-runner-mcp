# Adapting a project's Makefile for make-runner-mcp

**Audience: an AI coding agent**, of any capability level. Give this file
to an agent (attach it, paste it, or point at its path) with an instruction
like: *"Follow MAKEFILE-GUIDE.md exactly, in order, to make this project's
Makefile(s) compatible with make-runner-mcp."* The agent should be working
inside the target project's own repo — this file is not about
make-runner-mcp's own code.

This guide is written to be followed literally, step by step, with
copy-pasteable commands, rather than inferred from general Make knowledge.
**If a step's outcome is ambiguous, or you are not sure what to do, stop and
say so instead of guessing.** Every step below tells you exactly what to run
and what "stop and ask a human" looks like for that step.

## 0. The rule, stated once, precisely

An AI agent calling a target through make-runner-mcp may pass:

| Allowed | Example | Not allowed | Why |
|---|---|---|---|
| A flag from this exact list: `-n --dry-run --just-print --recon -B --always-make -k --keep-going -s --silent --quiet -i --ignore-errors -q --question` | `-n` | Any other flag, e.g. `-C`, `-f`, `-j`, `--eval` | Only these are allowlisted; everything else is rejected |
| `VAR=value`, where `value` matches `^[A-Za-z0-9 _.,+/@:^~=-]*$` | `ARGS=install symfony/console --no-dev` | `VAR=value` where value contains `` ; & | $ ` ' " < > ( ) { } # \ * ? [ ] `` or a newline | Those characters could break out of the recipe line make later runs through a real shell |
| `VAR=value` for any variable name **except**: `SHELL MAKE MAKEFLAGS MAKEFILES MAKELEVEL MAKECMDGOALS VPATH GPATH PATH` | `ARGS=...`, `ENV=staging` | `SHELL=...`, `PATH=...`, etc. | These control how make itself executes, not what a target does |
| — | — | Any bare word with no `VAR=` in front of it, e.g. `install`, `--no-dev`, `symfony/console` on its own | make would treat it as an *extra build goal*, which could run a second, unvetted target |

Everything in this guide exists to get a project's Makefile to fit inside
this table without changing what `make <target>` does for a human typing it
directly.

## 1. Find every file that defines targets

Run, from the project root:

```bash
test -f Makefile && echo "root Makefile: OK" || echo "STOP: no root Makefile — make-runner-mcp requires <project root>/Makefile to exist"
grep -n '^\s*\(-\|s\)\?include\s' Makefile
```

The second command lists any `include`/`-include`/`sinclude` lines in the
root Makefile. Open every file they point to, and repeat the same `grep`
on each of those (includes can nest). Write down the full list of files —
you'll re-check all of them in the steps below. If any include target uses
a `$(...)` variable in its path (e.g. `include $(ENV).mk`), make-runner-mcp
cannot resolve it either — note this file as **not scanned**, and flag it
in your final report (§8).

## 2. Detect the incompatible pattern

Run this across the root Makefile and every included file you found in
step 1 (repeat per file, or point `grep -r` at the whole project if all
your make files live under one directory):

```bash
grep -n "MAKECMDGOALS" Makefile
grep -n 'filter-out \$@' Makefile
grep -n "wordlist" Makefile
grep -n "^%:" Makefile
```

Any hit means at least one target relies on bare-word passthrough (the
`$(MAKECMDGOALS)` / catch-all-rule pattern) — this is what §0's "no bare
words" rule breaks. For each hit, find which real target's recipe consumes
it (read a few lines above/below the match) and add that target's name to
a list: **targets to convert**.

If none of the four commands return anything, skip to §6 — there's nothing
to convert, only the checks in §5–§7 still apply.

## 3. Convert each target on your list

For **each** target name in "targets to convert," do exactly this:

1. Open the file it's defined in.
2. Find its recipe (the indented line(s) under `target:`).
3. Replace every use of `$(MAKECMDGOALS)`, `$(filter-out $@,$(MAKECMDGOALS))`,
   or similar with a single variable named `ARGS`.
4. Rewrite (or write, if missing) its `##` comment to say, verbatim style:
   `## <what it does>. Pass args via ARGS, e.g. ARGS="<realistic example>"`

Template — replace the bracketed parts:

```makefile
# BEFORE
[TARGET]: ## [old comment, if any]
	[COMMAND] $(filter-out $@,$(MAKECMDGOALS))

# AFTER
[TARGET]: ## [what it does]. Pass args via ARGS, e.g. ARGS="[realistic example value]"
	[COMMAND] $(ARGS)
```

Concrete worked example:

```makefile
# BEFORE
composer: ## Run composer
	docker compose exec app composer $(filter-out $@,$(MAKECMDGOALS))

# AFTER
composer: ## Run composer inside the app container. Pass args via ARGS, e.g. ARGS="install symfony/console --no-dev"
	docker compose exec app composer $(ARGS)
```

Do not rename the target itself. Do not change what command it runs
(`docker compose exec app composer ...` stays the same) — only how it
receives its arguments changes.

## 4. Remove the dead catch-all rule, if it's now unused

After converting every target on your list, run step 2's commands again:

```bash
grep -n "MAKECMDGOALS" Makefile
grep -n "^%:" Makefile
```

If `^%:` still has a match and nothing else references `MAKECMDGOALS`
anymore, that catch-all rule (and its `@:` no-op recipe, and any
`.PHONY` entry naming it) is now dead code — delete it. If `MAKECMDGOALS`
still has matches, another target still depends on it: go back to §3 and
convert that one too, then re-run this check.

## 5. Check every target name against the hard-coded denylist

make-runner-mcp always blocks target names containing `deploy`, `destroy`,
`prod`, `publish`, or `release` as a substring (checked after removing any
`-`, `_`, `.` characters), plus anything starting with `rm-`. Run this to
find every target name and flag likely false positives:

```bash
grep -hoE '^[A-Za-z0-9][A-Za-z0-9_.-]*:($|[^=])' Makefile | sed 's/:.*//' | sort -u | while read -r t; do
  norm=$(echo "$t" | tr -d '_.-' | tr '[:upper:]' '[:lower:]')
  case "$norm" in
    *deploy*|*destroy*|*prod*|*publish*|*release*)
      echo "CHECK: '$t' will be blocked (matches denylist word)" ;;
  esac
  case "$t" in
    rm-*) echo "CHECK: '$t' will be blocked (starts with rm-)" ;;
  esac
done
```

(The `:($|[^=])` — colon followed by end-of-line or a non-`=` character — is
deliberate, not decoration: it's what keeps a variable assignment like
`RELEASE_TAG := v1.0.0` from being misread as a target named `RELEASE_TAG`
and wrongly flagged here. A plain `name:` pattern would catch that false
positive whenever there's no space before `:=`.)

For every line this prints: **do not rename the target yourself.** Decide
only whether it's a correct block (a real deploy/destroy/publish/release
target — leave it, this is working as intended) or a false positive (an
unrelated target that happens to contain the substring, e.g.
`producer-report`, `reproduce-fixture`). List every false positive in your
final report (§8) as `NEEDS HUMAN DECISION` — a human decides whether to
rename it.

## 6. Check for reliance on reserved variables

```bash
grep -nE '\$\((SHELL|MAKE|MAKEFLAGS|MAKEFILES|MAKELEVEL|MAKECMDGOALS|VPATH|GPATH|PATH)\)' Makefile
```

A match by itself is not necessarily a problem — Makefiles routinely use
`$(MAKE)` for recursive calls or `$(SHELL)` internally. It's only a problem
if a target's **documentation, comment, or README instructions tell a
caller to override one of these on the command line** (e.g. "run `make
build SHELL=/bin/bash`"). If you find that, list it in your final report as
`NEEDS HUMAN DECISION` — this pattern cannot be supported through
make-runner-mcp and the target needs to be restructured so callers don't
need to override that variable.

## 7. Backfill missing or oversized descriptions

```bash
grep -nE '^[A-Za-z0-9][A-Za-z0-9_.-]*:($|[^=])' Makefile | grep -v '##'
```

Every line this prints is a target with no `##` comment — it will show up
to an AI agent as a generic `Run 'make <name>'` description instead of a
useful one. Add one: `target: ## <one-sentence description>`. Keep each
comment under 200 characters (longer ones get truncated) and don't put
secrets, internal hostnames, or anything sensitive in it — the comment is
sent to every calling agent on every tool listing, whether or not the
target is ever invoked.

## 8. Validate your own `ARGS` example values

For every `ARGS="..."` example you wrote into a comment in §3, check the
example text itself against this pattern (letters, digits, spaces, and
`` _ . , + / @ : ^ ~ = - `` only):

```bash
python3 -c "import re,sys; s=sys.argv[1]; print('OK' if re.fullmatch(r'[A-Za-z0-9 _.,+/@:^~=-]*', s) else 'INVALID')" 'install symfony/console --no-dev'
```

(Swap in each example value you wrote.) If it prints `INVALID`, your
example itself wouldn't work through make-runner-mcp — pick a different,
representative example, or note in your final report that this target's
real-world arguments don't fit the safe character set and needs a human
decision (do not try to work around this — see §9).

## 9. Test your changes

**Always do this — it needs nothing but `make` itself:**

```bash
make -n [target] ARGS="[the example value from its comment]"
```

`-n` is a dry run: it prints the command make *would* run without running
it. Confirm the printed line has your `ARGS` value substituted in the
right place, and that the target isn't silently doing nothing. Do this for
every target you touched.

**If make-runner-mcp is available in this environment** (i.e. you can `cd`
into its repo and run Node), do this deeper check too — it exercises the
actual server, not just `make` directly:

```bash
cd /path/to/make-runner-mcp
PROJECT_DIR=/path/to/the/project node -e '
const { spawn } = require("child_process");
// MCP_TRANSPORT=stdio is required here: make-runner-mcp defaults to the
// http transport (for sandboxed-agent use, see its own README), and this
// probe talks to it over stdin/stdout, not a network port.
const child = spawn("node", ["server.js"], {
  env: { ...process.env, PROJECT_DIR: process.env.PROJECT_DIR, MCP_TRANSPORT: "stdio" },
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) console.log(line);
  }
});
function send(o) { child.stdin.write(JSON.stringify(o) + "\n"); }
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }), 300);
// Replace TOOL_NAME and the ARGS example with the target you are testing:
setTimeout(() => send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "make__TOOL_NAME", arguments: { args: ["ARGS=install symfony/console --no-dev"] } } }), 700);
setTimeout(() => { child.kill(); process.exit(0); }, 1200);
'
```

Check the `tools/list` response includes the target you converted, with
the description you wrote, and the `tools/call` response shows the
expected output with no `isError: true`.

If neither `make` nor Node/make-runner-mcp is available in your
environment at all, say so explicitly in your final report rather than
claiming you tested something you didn't run.

## 10. Final report — always produce this

End your work with a plain-text summary in this exact shape:

```
CONVERTED (MAKECMDGOALS -> ARGS):
- <target>: <one line: what changed>
- ...

REMOVED:
- <catch-all rule / dead code removed, or "none">

DESCRIPTIONS ADDED/UPDATED:
- <target>: <new comment text>
- ...

NEEDS HUMAN DECISION:
- <target>: <exact reason — denylist false positive / reserved-variable dependency / args don't fit the safe character set / include path uses a variable / etc.>
- ...

TESTED:
- <target>: <"dry-run only" | "dry-run + inspector" | "not tested — reason">
- ...

NOT TOUCHED (and why):
- <target>: <e.g. "already uses ARGS-style args, no change needed">
```

Do not omit sections — write "none" where nothing applies. This is what a
human reviews to decide what to actually merge.

## 11. Guardrails — do not do these, under any circumstance

- **Don't rename or restructure a target to dodge the hard-coded
  denylist** (`deploy`, `destroy`, `prod`, `publish`, `release`, `rm-*`).
  If it's genuinely one of those operations, leave it blocked — that's the
  system working correctly. Only §5's narrow false-positive case goes in
  your report, and even then a human decides, not you.
- **Don't try to route around the `VAR=value` character restriction** —
  no base64/hex-encoding a value and decoding it in the recipe, no string
  concatenation tricks, no alternate delimiters. If a target's real
  arguments don't fit the safe character set (§8), report it as
  `NEEDS HUMAN DECISION`. Do not invent a workaround.
- **Don't edit `.mcp-make-config.json` as a substitute for fixing a
  target.** That file only narrows which targets are exposed
  (`deny`/`allow`) and which env vars reach `make` (`envAllowlist`) — it
  has no effect on argument handling and won't make an incompatible target
  work.
- **Don't edit make-runner-mcp's own `server.js`** from inside a target
  project's repo to widen the allowed flags or reserved-variable list. If
  a project genuinely needs something currently blocked, that's a
  deliberate, separate change to make-runner-mcp itself — report it, don't
  make it yourself.
- **Don't mark something as tested if you didn't actually run a command
  and see its output.** If you couldn't test (missing tooling, no
  container running, etc.), say so plainly in §10 rather than guessing
  that it probably works.
