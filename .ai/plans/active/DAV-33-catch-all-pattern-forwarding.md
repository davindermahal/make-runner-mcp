# Plan: DAV-33 make-runner-mcp needs to handle catch-all pattern forwarding

**Status**: draft
**Branch**: feature/DAV-33-make-runner-mcp-needs-to-handle-catch-all-pattern-
**Created**: 2026-09-10
**Updated**: 2026-09-10

## Goal

`server.js`'s Makefile parser (`parseTargetsInto`) currently skips every
pattern rule, including the common "catch-all forwarding" idiom:

```makefile
%:
	@$(MAKE) -C docker $@
```

This idiom means: any goal not explicitly defined in the root Makefile is
forwarded to `docker/Makefile` (or whatever directory follows `-C`). Real
`make` resolves and runs these forwarded targets correctly today (verified
below) — the bug is purely in *discovery*: targets that only exist via this
forwarding are never listed as MCP tools, so an agent can't invoke them at
all. Fix the parser so it detects this exact idiom, follows it into the
target directory's `Makefile`, and exposes those targets too — with no
change to how a call is actually executed.

## Scope

**In scope:**
- Detecting a root or included Makefile's catch-all pattern rule (a rule
  whose target is exactly `%`) whose recipe recursively invokes
  `$(MAKE) -C <dir> ...` (with optional other flags/args before `-C`), and
  parsing `<dir>/Makefile` for additional targets, merged into the same
  target map used for `include` targets today.
- Preserving `make`'s own precedence: an explicit target defined anywhere
  in a file always wins over a same-named forwarded target, regardless of
  where the catch-all rule sits textually in that file.
- New automated tests covering this behavior (no test infrastructure
  exists in this repo today — see Testing strategy).

**Out of scope (do not touch):**
- `runMake`, `isAllowed`, `loadConfig`, `buildChildEnv`, the HTTP
  transport, session handling, or `validateArg` — none of these need to
  change; the fix is entirely inside `parseTargetsInto`/`parseTargets`.
- Supporting `--directory=<dir>` or any other spelling of the "change
  directory" flag besides `-C` (with or without a space before the
  value) — see Confirm at Review.
- The *different*, already-documented "argument bare-word passthrough"
  catch-all idiom described in `MAKEFILE-GUIDE.md` §2–4 (a `%:` rule with
  an `@:` no-op recipe used to swallow `$(MAKECMDGOALS)` bare words). That
  idiom has no `$(MAKE) -C ...` recipe, so this change's detection never
  matches it, and `MAKEFILE-GUIDE.md`'s existing "convert or remove it"
  guidance for that idiom is untouched. This plan only adds a small
  clarifying note distinguishing the two (see Files to change).

## Verified facts (from local experiments, not assumption)

1. Real `make` already executes a forwarded target correctly through this
   server's existing invocation shape (`make -f <Makefile> <target>`) with
   **no code change needed on the execution side** — confirmed by running
   `make -f Makefile build` against a root Makefile with a `%: @$(MAKE) -C
   docker $@` rule and a `docker/Makefile` defining `build`: it printed
   `docker`'s recipe output. The recursive `$(MAKE) -C docker <target>`
   call correctly `cd`s into `docker` and runs `docker/Makefile`'s own
   (unrelated, implicit) `Makefile` lookup — not `-f`, so it doesn't need
   to know our server's `-f` path at all.
2. The existing per-line target regex
   (`/^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)(?:[^=]*)$/`) can never match a
   bare `%` target name — `%` isn't in either character class — so the
   dead code at server.js:318 (`if (name.includes("%")) continue;`) never
   actually runs today; pattern rules are already filtered out one step
   earlier by the regex itself failing to match. A new, separate regex is
   needed to specifically detect the `%:` catch-all line (see Key
   decisions).
3. Real `make` prefers an explicit rule over a pattern rule regardless of
   which one appears first in the file — confirmed by putting the `%:`
   rule *before* an explicit `build:` rule in the same file and observing
   `make -f Makefile build` still ran the explicit rule's recipe, not the
   forwarded one. The new parser logic must match this (see Key decision
   3 below) or it will show a misleading tool description (though it
   would never mis-*execute*, since real `make` always resolves this
   correctly at call time independent of what the parser recorded).

## Files to change

- `server.js` — add catch-all-forwarding detection to `parseTargetsInto`;
  update the file's top doc comment (lines 3–23) to mention forwarded
  targets are now discovered; remove the dead `if (name.includes("%"))
  continue;` line since the new code makes pattern-rule handling explicit
  and that line is not merely redundant but actively misleading about how
  pattern rules are filtered (see Verified fact 2).
- `test/fixtures/catch-all-forward/Makefile` (new) — root fixture with an
  explicit target, a forwarding `%:` rule, and a hard-denylisted target
  name forwarded from the sub-Makefile (to prove the denylist still
  applies to forwarded targets).
- `test/fixtures/catch-all-forward/docker/Makefile` (new) — the forwarding
  target directory's Makefile.
- `test/fixtures/catch-all-edge-cases/Makefile` (new) — fixture isolating
  the two "must NOT be treated as forwarding" cases: a non-catch-all
  pattern rule (`%.o: %.c`) and a catch-all whose `-C` directory is an
  unresolvable `$(VAR)`.
- `test/catch-all-forwarding.test.js` (new) — the test suite (see Testing
  strategy).
- `package.json` — add `"scripts": { "test": "node --test" }`. Config
  only, no behavior change, no test needed for this line itself.
- `MAKEFILE-GUIDE.md` — one clarifying paragraph in §2 ("Detect the
  incompatible pattern") noting that a `%:` rule whose recipe forwards via
  `$(MAKE) -C <dir> ...` is a different, now-supported idiom and is not
  what §2–4's "dead catch-all rule" guidance is about. Docs only, no test
  needed.

## Key decisions

1. **Detection is narrow and structural, not a heuristic guess.** A line's
   rule part (everything before an unescaped `#`, same comment-stripping
   already used for normal targets) must match exactly `^%\s*:(?!=)(?:[^=]*)$`
   — i.e., the target name is *only* `%`, nothing else. This is the
   standard "match any goal" catch-all idiom. A suffix/prefix pattern rule
   like `%.o: %.c` or `docker-%:` does **not** match this regex and is
   left alone, same as today (verified: see the edge-case fixture).
2. **Forward-directory extraction scans only the rule's own recipe
   lines** (consecutive lines immediately following the `%:` line that
   start with a tab — real `make`'s own recipe-line convention), stopping
   at the first line that doesn't start with a tab. Within those lines,
   the first match of `/\$\(MAKE\)[^\n]*?-C\s*"?([^\s"]+)"?/` (lazy
   match, so it finds the *first* `-C` after `$(MAKE)` even if other
   flags like `--no-print-directory` come first) gives the target
   directory. If the captured directory string contains `$` (an
   unresolvable make variable, e.g. `-C $(SUBDIR)`), skip it — same
   "can't resolve variable expansions" rule already applied to `include`
   directives (server.js:291), not a new concept.
3. **Forward resolution is deferred to the end of each file's own line
   loop**, not done inline the moment the `%:` line is seen. Collect
   candidate forward directories into a local array while scanning the
   file; after the file's full line loop finishes (which already handles
   every explicit target and every inline `include`d file's targets),
   iterate that array and recurse into each `<dir>/Makefile` last. This
   makes an explicit target in this file always win over a same-named
   forwarded one in the `targets` map, matching real `make`'s own
   precedence (Verified fact 3) regardless of whether the explicit target
   is declared before or after the `%:` line. This does not extend to
   precedence across separate files reached via `include` — an explicit
   target in a file `include`d *after* the file containing the `%:` rule
   can still lose to a forwarded one in the map; this is a pre-existing
   style of limitation (order-sensitive `include` resolution already
   exists today) and, per Verified fact 1, never affects what actually
   *runs* — only, in this rare cross-file collision case, which
   description text is shown. Accepted, not fixed here.
4. **Reuse `MAX_INCLUDE_DEPTH` and the existing `visited` set** for the
   recursive `parseTargetsInto` call into the forwarded directory's
   Makefile — no new depth constant or cycle-detection mechanism. This
   also means a forwarding chain that loops back on itself (`docker/`'s
   Makefile forwards back to the root) terminates safely via the existing
   `visited.has(real)` check, and a chain deeper than 8 hops stops via the
   existing depth check — both already exercised by the `include` path,
   so no new failure mode is introduced.
5. **The sub-Makefile must be named exactly `Makefile`** (`path.resolve(fileDir,
   forwardDir, "Makefile")`), matching how the project's own root Makefile
   path is already hardcoded as exact-case `"Makefile"` (server.js:74) —
   no `makefile`/`GNUmakefile` fallback. Consistent with existing behavior,
   not a new restriction.
6. **No dependency added for testing.** This repo has zero existing test
   infrastructure (no test framework in `package.json`, no `test/`
   directory). `server.js` also can't be unit-tested by importing it
   directly — it's a script with top-level side effects (`existsSync`
   checks that call `process.exit(1)`, an HTTP server bind) that fire on
   import, not an exported library. Given that, tests are black-box:
   spawn `node server.js` as a real child process with
   `MCP_TRANSPORT=stdio` and a fixture `PROJECT_DIR`, and drive it over
   stdio with JSON-RPC — the exact transport/protocol
   `MAKEFILE-GUIDE.md` §9 already documents and recommends for manual
   verification. Use Node's built-in `node:test` + `node:assert/strict`
   (stable since Node 18, available in this project's Node 24) — zero new
   npm dependencies, nothing to add to `package-lock.json`.

## Implementation order

### Step 1 (test): Add fixtures and the failing test for catch-all forwarding

Create `test/fixtures/catch-all-forward/Makefile`:

```makefile
.PHONY: help
help: ## Show help
	@echo top-level help

%:
	@$(MAKE) --no-print-directory -C docker $@
```

Create `test/fixtures/catch-all-forward/docker/Makefile`:

```makefile
build: ## Build the docker image
	@echo building docker image

deploy-app: ## Deploy the app (must stay blocked by the denylist)
	@echo this must never print through the MCP tool
```

Create `test/fixtures/catch-all-edge-cases/Makefile`:

```makefile
.PHONY: help
help: ## Show help
	@echo top-level help

%.o: %.c
	@echo pattern compile rule, not a catch-all

%:
	@$(MAKE) -C $(SUBDIR) $@
```

(No `docker`/other subdirectory needed for this fixture — the point is
that neither pattern rule should add any forwarded target.)

Create `test/catch-all-forwarding.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "server.js");

function startServer(projectDir) {
  const child = spawn("node", [SERVER], {
    env: { ...process.env, PROJECT_DIR: projectDir, MCP_TRANSPORT: "stdio" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  let nextId = 1;
  function send(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout waiting for response to ${method}`));
        }
      }, 5000);
    });
  }
  return { child, send };
}

async function initialized(projectDir) {
  const s = startServer(projectDir);
  await s.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  return s;
}

test("catch-all %: forwarding rule exposes the target directory's targets", async () => {
  const fixture = path.join(__dirname, "fixtures", "catch-all-forward");
  const { child, send } = await initialized(fixture);
  try {
    const list = await send("tools/list", {});
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes("make__help"), "root-level target still listed");
    assert.ok(names.includes("make__build"), "forwarded target from docker/Makefile is listed");
    assert.ok(
      !names.includes("make__deploy-app"),
      "forwarded target matching the hard denylist is still blocked"
    );

    const call = await send("tools/call", { name: "make__build", arguments: {} });
    assert.equal(call.result.isError, false, "forwarded target actually executes");
    assert.match(call.result.content[0].text, /building docker image/);
  } finally {
    child.kill();
  }
});

test("a non-catch-all pattern rule and an unresolvable forward dir are ignored, not crashed on", async () => {
  const fixture = path.join(__dirname, "fixtures", "catch-all-edge-cases");
  const { child, send } = await initialized(fixture);
  try {
    const list = await send("tools/list", {});
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes("make__help"), "root-level target still listed");
    assert.equal(
      names.some((n) => n.includes("%")),
      false,
      "no tool derived from a literal % pattern rule name was ever created"
    );
    assert.equal(names.length, 1, "no target was pulled in from an unresolvable $(SUBDIR) forward");
  } finally {
    child.kill();
  }
});
```

Add to `package.json`'s top-level object:

```json
  "scripts": {
    "test": "node --test"
  },
```

**Acceptance check (red):** run `npm test`. Both tests fail: the first on
`assert.ok(names.includes("make__build"), ...)` (not yet discovered), the
second passes already (nothing to break yet) — confirm the *first* test's
failure message names `make__build`, proving the test exercises the real
gap, not a typo or a vacuous assertion.

### Step 2 (implementation): Detect and follow catch-all forwarding

In `server.js`, replace the body of `parseTargetsInto` (currently
server.js:270–328) with a version that:

1. Iterates lines by index (`for (let i = 0; i < lines.length; i++)`
   instead of `for (const line of lines)`), so it can look ahead at
   recipe lines.
2. Declares `const forwardDirs = [];` before the loop.
3. After the existing `include`-directive check and before the existing
   target regex match, inserts:

   ```js
   const catchAll = rulePart.match(/^%\s*:(?!=)(?:[^=]*)$/);
   if (catchAll) {
     let j = i + 1;
     let forwardDir = null;
     while (j < lines.length && /^\t/.test(lines[j])) {
       const mk = lines[j].match(/\$\(MAKE\)[^\n]*?-C\s*"?([^\s"]+)"?/);
       if (mk && !forwardDir) forwardDir = mk[1];
       j++;
     }
     i = j - 1;
     if (forwardDir && !forwardDir.includes("$")) forwardDirs.push(forwardDir);
     continue;
   }
   ```

   (Note `rulePart` must already be computed above this point, same as
   today — move the existing comment-stripping two lines above the
   `include` check if needed so both the `include` and this new check can
   use it consistently; today only the target-regex match uses
   `rulePart`, so check line order carefully against the current file
   before inserting.)
4. Removes the now-covered dead line `if (name.includes("%")) continue;`
   (server.js:318) — the new `catchAll` check above already intercepts
   every possible `%` case before the main regex would even be reached,
   and per Verified fact 2 the regex could never have matched a `%` name
   anyway.
5. After the existing `for` loop ends (still inside `parseTargetsInto`,
   before its `return`... note the function is `void`/no explicit return
   today, so this is simply the next statement after the loop), adds:

   ```js
   for (const dir of forwardDirs) {
     parseTargetsInto(path.resolve(fileDir, dir, "Makefile"), targets, visited, depth + 1);
   }
   ```

Also update the file's top doc comment (server.js:3–23): add one sentence
after the existing "Parses the project's own Makefile (following any
`include`/`-include` directives...)" sentence noting that a root catch-all
pattern rule (`%:`) whose recipe recursively invokes `$(MAKE) -C <dir>
...` is also followed, so targets only reachable through that forwarding
are discovered and exposed the same as any other target.

**Acceptance check (green):** run `npm test`. Both tests in
`test/catch-all-forwarding.test.js` pass. Additionally run, by hand, the
exact stdio probe script already given in `MAKEFILE-GUIDE.md` §9 against
`test/fixtures/catch-all-forward` and confirm `tools/list` includes
`make__build` and `tools/call` on it prints `building docker image` with
no `isError: true` — this is the same check the automated test already
makes, done once more manually as a sanity cross-check since this server
has no prior manual-QA precedent to compare against.

### Step 3 (docs, no test needed — clarification only): Update MAKEFILE-GUIDE.md

In §2 ("Detect the incompatible pattern"), immediately after the existing
`grep -n "^%:" Makefile` bullet's explanation paragraph, add a short
paragraph: a `%:` rule whose recipe's body contains `$(MAKE)` with a `-C`
flag is a *different*, already-supported idiom (target forwarding to
another directory's Makefile) — as of this fix, make-runner-mcp discovers
and exposes those forwarded targets automatically, so this kind of `%:`
rule is not "dead code" and §4's "remove the dead catch-all rule" does
not apply to it. Only a `%:` rule that swallows bare-word
`$(MAKECMDGOALS)` arguments (typically paired with an `@:` no-op recipe,
no `$(MAKE) -C ...` call) is the incompatible pattern this guide's §3–4
converts or removes.

**Acceptance check:** re-read the edited §2 paragraph once and confirm it
does not contradict or duplicate the existing §2–4 flow — it only adds a
disambiguating note; no other line in the file changes.

## Testing strategy

Test commands: `npm test` (added in Step 1; equivalent to `node --test`,
which auto-discovers `test/catch-all-forwarding.test.js`).

- **Catch-all forwarding, pass path**: `test/catch-all-forwarding.test.js`
  → `"catch-all %: forwarding rule exposes the target directory's
  targets"`. Covers: forwarded target is listed, root-level target is
  still listed unaffected, a forwarded target that matches the hard
  denylist is still blocked, and the forwarded tool actually executes and
  returns the expected output.
- **Catch-all forwarding, error/boundary path**:
  `test/catch-all-forwarding.test.js` → `"a non-catch-all pattern rule and
  an unresolvable forward dir are ignored, not crashed on"`. Covers: a
  suffix pattern rule (`%.o: %.c`) never becomes a tool or crashes the
  parser, and a catch-all with an unresolvable `-C $(SUBDIR)` value is
  silently skipped (server keeps working, lists only the real root
  target) rather than throwing.
- No existing test suite exists to regress (Key decision 6) — these two
  tests are the entire suite after this change; `npm test` passing in
  full is the whole regression bar.

## QA Plan

Automated coverage above exercises the parser through the real MCP
protocol (stdio JSON-RPC) against real Makefiles and real `make`
execution of the forwarded target — there is no mocking of `make` or the
filesystem, so this is already close to the real integration surface.

Manual verification still worth doing, because it exercises this
project's actual distribution path (a client spawning it via `npx
github:...`) rather than a direct `node server.js` invocation, which the
automated tests use for speed/isolation:

1. In a scratch directory outside this repo, create a root `Makefile` and
   a `docker/Makefile` matching the fixture shapes in Step 1 above.
2. Run:
   ```bash
   PROJECT_DIR=/path/to/scratch/dir MCP_TRANSPORT=stdio node /path/to/make-runner-mcp/server.js
   ```
   and drive it with the exact stdio probe script from `MAKEFILE-GUIDE.md`
   §9, swapping in `make__build` (or whatever forwarded target name you
   used) for `TOOL_NAME`.
3. **Pass criteria**: the `tools/list` response's JSON includes an entry
   whose `name` is `make__build`; the `tools/call` response's
   `result.isError` is `false` (or absent) and `result.content[0].text`
   contains the forwarded recipe's real output.
4. **Fail criteria**: `make__build` is absent from `tools/list` (the bug
   this ticket reports), or `tools/call` returns `isError: true` with
   `"is not a currently allowed target"`.

## Boundaries

- **Files/directories the implementer must not touch**: `README.md`
  (no user-facing behavior or setup instructions change — this is an
  internal parsing fix); `.mcp-make-config.example.json`;
  `package-lock.json` (no new dependency is added, so this file should not
  change — if `npm install` or any command modifies it, that's a signal
  something went wrong, stop and check); any function in `server.js`
  outside `parseTargetsInto`'s body and the top file-header comment
  (`runMake`, `isAllowed`, `loadConfig`, `buildChildEnv`, `toolNameFor`,
  `buildToolEntries`, the HTTP transport block, and the `if
  (MCP_TRANSPORT === "http")` branch are all out of scope and must not
  change).
- **What the implementer must not add on its own initiative**: no new npm
  dependency (test framework, glob matcher, etc. — `node:test` and
  `node:assert/strict` are sufficient and already available); no support
  for `--directory=<dir>` or any `-C` spelling beyond `-C dir`/`-Cdir`
  (Confirm at Review item below covers this — if it turns out to be
  needed, that's a follow-up ticket, not silently added here); no
  annotation/prefix added to a forwarded target's description text (it
  should read exactly as its own `##` comment, identical treatment to an
  `include`d target today); no refactor of `parseTargetsInto`'s existing
  `include`-handling code path beyond what's needed to add the `forwardDirs`
  array and the deferred loop after it.
- **Explicit stop conditions**: if `npm test` still fails after one fix
  attempt in Step 2; if the regex in Key decision 2 needs to match
  something not already covered by the two fixtures here (stop and add a
  fixture + failing test first, per the TDD flow — never hand-tune the
  regex against an ad hoc Makefile without a test capturing why); if
  `parseTargetsInto`'s current line-processing order (which check runs
  before which) doesn't match what Step 2's instructions assume — re-read
  the current file first and report the actual order rather than guessing
  where to insert the new check.
- **Boundaries win even when crossing one looks like the more "correct"
  fix.** If, mid-implementation, supporting `--directory=` or annotating
  forwarded descriptions starts to look clearly better, raise it under
  Open Questions / stop-and-report instead of just doing it.

## Open Questions

None.

## Confirm at Review

- [ ] Only `-C <dir>` / `-C<dir>` (GNU make's short flag, space optional)
      is detected as the forwarding flag — not `--directory=<dir>`. The
      ticket's own example uses `-C`, and it's by far the more common
      spelling in the wild. Recommendation: ship with `-C` only; if a real
      project needs `--directory=`, that's a fast, low-risk follow-up to
      this same regex, not worth speculatively building now.
- [ ] Forwarded targets get no special marker in their MCP tool
      description (e.g. no "(forwarded from docker/Makefile)" suffix) —
      they're described using their own `##` comment exactly like an
      `include`d target is today. Recommendation: keep this consistent;
      adding a marker for one discovery mechanism (`%:` forwarding) but
      not the other (`include`) would be an arbitrary inconsistency.
- [ ] The forwarding directory's makefile must be named exactly
      `Makefile` (no `makefile`/`GNUmakefile` fallback), matching how this
      project's own root Makefile path is already hardcoded
      (server.js:74). Recommendation: keep this consistent rather than
      adding fallback resolution logic nothing else in this file has.
