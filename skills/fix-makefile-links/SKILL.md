---
description: Find every Makefile in the current project, check which ones make-runner-mcp can actually discover (via a real `include`/`-include` directive, the `%:` catch-all forwarding idiom, or a `## make-runner: also-read <path>` marker), and add the missing link automatically for any that are orphaned — instead of just reporting the gap. Only run when explicitly invoked as /fix-makefile-links.
argument-hint: [optional: path to a local make-runner-mcp checkout, to run --diagnose for live verification]
disable-model-invocation: true
allowed-tools: Read Glob Grep Bash Edit AskUserQuestion
---

# Fix make-runner-mcp Makefile linking

Input: $ARGUMENTS (optional path to a make-runner-mcp checkout — see Step 5)

Goal: make sure every Makefile in this project that defines real targets is
actually reachable from `<project root>/Makefile` — the only file
make-runner-mcp reads — and fix it automatically where it isn't, rather
than just telling the user their Makefile isn't being picked up.

This handles **linking/discovery only**. It does not touch recipe bodies,
convert `$(MAKECMDGOALS)`-style argument passing, or fix denylist false
positives — those are separate, higher-judgment concerns covered by
make-runner-mcp's own `MAKEFILE-GUIDE.md`; mention it in your final report
if you notice any of those along the way, but don't act on them here.

## Step 0: Preconditions

- Confirm a root `Makefile` exists at the project root (where this was
  invoked, or a directory the user named in $ARGUMENTS/the conversation).
  If not, stop and say so — make-runner-mcp requires
  `<project root>/Makefile` to exist; there's nothing to link yet.
- `git status --porcelain` (if this is a git repo). If dirty, proceed
  anyway — the only edit this skill makes is appending comment lines to
  the root Makefile — but mention in the final report that the edit will
  land alongside whatever else is already uncommitted.

## Step 1: Inventory every Makefile in the project

```bash
find . -name Makefile \
  -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/vendor/*' \
  -not -path '*/.venv/*' -not -path '*/venv/*'
```

Read every file this finds. Set aside the root one; everything else is a
**candidate secondary Makefile**.

If this returns only the root Makefile, stop here and report: "Only one
Makefile in this project — nothing to link." Don't invent work.

## Step 2: Resolve what the root Makefile already reaches

Read the root Makefile (and recurse into anything it reaches, same as
below) and classify every line into one of three link mechanisms —
this mirrors exactly what make-runner-mcp's own parser does, so a file
found here is one make-runner-mcp already discovers today:

1. **Real include**: a line matching `^\s*(-|s)?include\s+(.+)$`. Each
   whitespace-separated path on the line, resolved relative to the
   *including* file's own directory. A path containing `$(` can't be
   resolved by make-runner-mcp either — note it as **unresolvable
   include** (see Step 4) rather than treating it as reachable.
2. **Catch-all forwarding**: a rule whose target is bare `%:` (not
   `%.o:` or `docker-%:` — those are ordinary pattern rules, not this
   idiom), whose recipe (the tab-indented lines immediately after it)
   contains `$(MAKE) ... -C <dir>`. Reaches `<dir>/Makefile`. A `-C`
   value containing `$(` similarly can't be resolved — note it the same
   way as an unresolvable include.
3. **The marker this skill itself manages**: a comment line matching
   `^\s*#{1,2}\s*make-runner:\s*also-read\s+(.+)$`. Each
   whitespace-separated path, resolved the same way as `include`.

For every file reached via (1) or (3), recurse into it too — apply the
same three checks to its contents, since an included/linked file can
itself `include` or mark further files. (Forwarding targets, (2), are a
Makefile invoked by a live `$(MAKE)` at build time in a fresh directory
context, not textually processed further here — don't recurse into them
for more forwarding/include chains; treat the forwarded file itself as
reached and stop there, matching what make-runner-mcp's own parser does.)

Build the **reached set**: the realpath of every file resolved this way,
starting from the root Makefile itself.

## Step 3: Compute the gap

Any candidate secondary Makefile from Step 1 whose realpath is **not** in
the reached set from Step 2 is **orphaned** — make-runner-mcp cannot see
its targets right now, regardless of why (never referenced at all, or
referenced only via an unresolvable `$(VAR)` path).

If the gap is empty: report "All Makefiles are already correctly linked —
nothing to fix" and stop.

## Step 4: Fix each orphaned file

For each orphaned Makefile, the default and safest fix is to append this
line to the root Makefile (near any existing `include`/`also-read` lines
if present, otherwise near the top, after any leading variable
assignments):

```makefile
## make-runner: also-read <path, relative to the root Makefile's directory>
```

This is a plain comment — it changes nothing about what a human running
`make` by hand experiences, and it works regardless of *why* the file was
orphaned. Prefer it over adding a real `include` here: a real `include`
would need you to verify the whole orphaned file is safe to textually pull
into the root Makefile's namespace (no colliding variable/target names,
no assumption about running from a different `cwd`), which is exactly the
kind of judgment call this skill should not make silently.

**Exception — flag instead of auto-fixing:** before applying the marker to
a given orphaned file, grep its recipes for `$(UPPERCASE_VAR)`-style
tokens and check whether each one is assigned *only* in the root Makefile
and not in the orphaned file itself (excluding standard built-ins like
`$(MAKE)`, `$(CC)`, `$(SHELL)`). If you find one, the `also-read` marker
would run this file without that variable defined — likely breaking or
silently changing its recipe. For that file only: don't edit anything,
add it to a **NEEDS HUMAN DECISION** list in your final report with the
variable name and where it's defined, and suggest either (a) defining that
variable directly in the orphaned file too, or (b) using a real `include`
once a human has verified there's no namespace collision. This is a
heuristic, not exhaustive — say so.

Apply the marker fix for every other orphaned file in one edit to the root
Makefile (one line per file), then move on.

## Step 5: Verify

Re-run Step 2's classification by hand against the now-edited root
Makefile and confirm every previously-orphaned file (other than ones left
for human decision) now appears in the reached set.

If $ARGUMENTS names a local make-runner-mcp checkout (a directory
containing `server.js`), or `command -v make-runner-mcp` resolves to
something, run the real thing for a live check instead of trusting your
own by-hand classification alone:

```bash
PROJECT_DIR="$(pwd)" node <path-to-that-checkout>/server.js --diagnose
```

Check its `EXPOSED TARGETS` section lists targets from the newly-linked
file(s), and its `UNRESOLVED ... PATHS` / `FILES REJECTED` sections are
empty for the files you just fixed. If no checkout is available, say so in
the report and note that the by-hand verification above stands in for it.

Do **not** invoke any actual `make <target>` to test — that executes real
recipes, which is outside what this skill is for.

## Step 6: Report

State plainly, in this shape:

```
MAKEFILES FOUND:
- <path>: <root | already linked via include/forwarding/also-read | orphaned>

FIXED (also-read marker added to root Makefile):
- <path>

NEEDS HUMAN DECISION:
- <path>: <reason — e.g. "recipe uses $(FOO), only defined in root Makefile">

VERIFIED: <"live --diagnose output matches" | "by-hand classification only — no make-runner-mcp checkout available to confirm">
```

Also mention, once, that the `also-read` marker only works with a
make-runner-mcp version that supports it — if this project's MCP client
config pins an older release tag, the fix won't take effect until that
tag is bumped.
