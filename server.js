#!/usr/bin/env node
/**
 * make-runner MCP server (dynamic)
 *
 * Parses the project's own Makefile (following any `include`/`-include`
 * directives, e.g. a root Makefile pulling in `docker/Makefile`) and
 * exposes one MCP tool per discovered target. Also follows a root catch-all
 * pattern rule (`%:`) whose recipe recursively invokes `$(MAKE) -C <dir>
 * ...`, so targets only reachable through that forwarding are discovered
 * and exposed too. For a second Makefile that isn't reachable through
 * either of those real make mechanisms (e.g. its include path uses a
 * `$(VAR)` this server can't resolve, or it's a wholly separate,
 * independently-invoked Makefile), a `# make-runner: also-read <path>`
 * comment anywhere in a parsed file tells this server (not `make`) to also
 * read that file's targets — those are then run directly against that
 * file (see MAKEFILE-GUIDE.md). Nothing is exposed or
 * executed that isn't literally a target defined in those files — the
 * model can't construct or type an arbitrary command, only invoke targets
 * that already exist in files your team presumably reviews like any other
 * source file.
 *
 * `make` is always invoked with an explicit `-f <Makefile>` pointing at
 * the exact file that was parsed, and extra `args` are restricted to a
 * flag allowlist plus `VAR=value` pairs (excluding make/shell control
 * variables, including PATH) — no bare positional argument is ever
 * permitted, since make treats one as an *additional build goal*, not
 * just data, which would let a call smuggle a second, unvetted target
 * onto an otherwise-allowed invocation. So a call can never swap in a
 * different makefile, change directory, hijack what a recipe's bare
 * commands resolve to, invoke an extra target, or otherwise run
 * something other than the single vetted target it names.
 *
 * Env vars:
 *   PROJECT_DIR          - project root containing the Makefile (required)
 *   MCP_MAKE_CONFIG       - optional path to a JSON config, default:
 *                           <PROJECT_DIR>/.mcp-make-config.json
 *   MCP_TRANSPORT         - "http" (default) or "stdio". http is the
 *                           default because it's the only mode that works
 *                           correctly when the *calling* agent runs inside
 *                           its own sandbox: the server runs here, outside
 *                           any sandbox, with normal access to whatever it
 *                           needs (e.g. the real Docker daemon), and the
 *                           agent reaches it only over the network — never
 *                           via a locally-spawned subprocess, which is what
 *                           stdio requires and which a sandboxed agent
 *                           re-execs *inside* its own container (see
 *                           README's "Running behind a sandbox"). Set
 *                           MCP_TRANSPORT=stdio to opt back into the
 *                           simpler subprocess-per-client-config model for
 *                           direct, unsandboxed use.
 *   MCP_HTTP_HOST         - http mode only; default 0.0.0.0
 *   MCP_HTTP_PORT         - http mode only; default 8791
 *   MCP_HTTP_TOKEN        - http mode only; REQUIRED, no default. The
 *                           server refuses to start without one — see
 *                           README for how callers authenticate with it.
 *
 * Config file shape (all fields optional):
 * {
 *   "deny": ["deploy", "destroy", "prod"],   // substrings to block
 *   "allow": ["up", "test", "composer"],      // if present, ONLY these run
 *   "envAllowlist": ["PATH", "HOME"]          // if present, ONLY these env vars reach make
 * }
 * A config that fails to parse, or an `allow`/`envAllowlist` entry that
 * isn't a valid string array, fails closed (denies everything / passes no
 * env vars) rather than silently falling back to unrestricted access.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = path.resolve(process.env.PROJECT_DIR || process.cwd());
const MAKEFILE = path.join(PROJECT_DIR, "Makefile");
const CONFIG_PATH =
  process.env.MCP_MAKE_CONFIG || path.join(PROJECT_DIR, ".mcp-make-config.json");

// This server's own location, not the target project's — used to serve the
// "fix-makefile-links" MCP prompt (below) straight from the same checkout
// this server is running from, and to point that prompt's own verification
// step back at this exact server.js rather than asking whoever receives
// the prompt to go find one.
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const FIX_MAKEFILE_LINKS_SKILL_PATH = path.join(
  path.dirname(SCRIPT_PATH),
  "skills",
  "fix-makefile-links",
  "SKILL.md"
);

// HTTP is the default transport (stdio is the opt-in) specifically so this
// server runs *outside* a sandboxed agent's own container/filesystem, with
// the agent reaching it only over the network, never via a locally-spawned
// subprocess or a mounted socket — see the README's "Running behind a
// sandbox" section for why that separation matters and what broke without
// it. Breaking change from earlier versions: a client config that spawns
// this as a subprocess expecting stdio (the old default) must now set
// MCP_TRANSPORT=stdio explicitly, or it'll get an HTTP server trying to
// bind a port instead of a stdio handshake.
const MCP_TRANSPORT = process.env.MCP_TRANSPORT || "http";
const MCP_HTTP_HOST = process.env.MCP_HTTP_HOST || "0.0.0.0";
const MCP_HTTP_PORT = Number(process.env.MCP_HTTP_PORT || 8791);
const MCP_HTTP_TOKEN = process.env.MCP_HTTP_TOKEN || "";
const TIMEOUT_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 5000;
const MAX_OUTPUT_BYTES = 200_000;
const MAX_INCLUDE_DEPTH = 8;
// A session that never sends a proper close (crashed/killed client, buggy
// client) would otherwise stay in `sessions` forever; swept on a timer
// rather than trusting every client to close cleanly.
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// Makefile `## comment` text is surfaced verbatim as MCP tool descriptions
// — untrusted-adjacent content read straight into the calling agent's
// context on every listTools call, whether or not the target is ever
// invoked. This doesn't make that content trustworthy, but it bounds how
// much of it (and therefore how large an injected payload) gets through.
const MAX_DESCRIPTION_LENGTH = 200;

// Built-in denylist floor, always applied regardless of config. Words are
// matched with separators stripped so a target can't dodge the floor by
// inserting a `-`/`_`/`.` (e.g. "de-ploy", "re_lease"). "rm-" is matched as
// a literal prefix instead — stripping separators for it would make it
// match almost anything containing "rm" (confirm, affirm, firmware, ...).
const HARD_DENY_WORDS = ["deploy", "destroy", "prod", "publish", "release"];
const HARD_DENY_PREFIXES = ["rm-"];

// `make` flags are allowlisted, not blocklisted: anything not on this list
// is rejected, including -f/--file, -C/--directory, -I/--include-dir and
// --eval, all of which could point make at a different makefile or inject
// unrelated rules — precisely the escape hatch this server exists to close.
const SAFE_FLAGS = new Set([
  "-n", "--dry-run", "--just-print", "--recon",
  "-B", "--always-make",
  "-k", "--keep-going",
  "-s", "--silent", "--quiet",
  "-i", "--ignore-errors",
  "-q", "--question",
]);

// VAR=value command-line assignments are allowed, but never for variables
// that control which interpreter, makefile(s), or executable search path
// are used — overriding these changes *how* (or via what) a target's
// commands execute, independent of the target itself, and command-line
// assignments take precedence over both the Makefile and the environment.
// PATH is included here because make auto-exports command-line variable
// assignments into every recipe's shell environment — an attacker-chosen
// PATH would let a recipe's bare command names (npm, git, sh, ...) resolve
// to an attacker-controlled binary instead of the real one.
//
// VAR_ASSIGNMENT only matches names starting with a letter/underscore, so
// every dot-prefixed GNU Make special variable (.SHELLFLAGS,
// .RECIPEPREFIX, .EXTRA_PREREQS, ...) simply fails to match VAR_ASSIGNMENT
// and falls through to validateArg()'s catch-all rejection (every bare/
// unrecognized argument is rejected outright) rather than needing to be
// named here individually. That's deliberate: allowlisting VAR_ASSIGNMENT
// to admit a leading dot would
// also newly admit variables like .EXTRA_PREREQS (which can force an
// unrelated, possibly-denied target to run as a prerequisite) unless every
// dangerous one were enumerated — the categorical block is safer than a
// denylist we might forget to keep complete.
const DANGEROUS_VARS = new Set([
  "SHELL", "MAKE", "MAKEFLAGS", "MAKEFILES", "MAKELEVEL",
  "MAKECMDGOALS", "VPATH", "GPATH", "PATH",
]);
const VAR_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

// Deliberately more permissive than SAFE_ARG/SAFE_FLAGS: this is the value
// half of a VAR=value pair, which is how a target's own recipe (e.g.
// `composer: ## $(ARGS) passed to composer` running `composer $(ARGS)`)
// receives passthrough arguments like "install symfony/console --no-dev".
// Spaces are allowed on purpose so a whole argument list can travel as one
// argv element to `make` — argv, not a shell, so spaces here don't create
// any injection risk against *our* spawn() call. The risk that matters is
// downstream: make substitutes this value into a recipe line, which make
// then runs via `$(SHELL) -c "..."`, a real shell. So the charset still
// excludes anything that shell could interpret as a control/metacharacter
// (; & | $ ` ' " < > ( ) { } newline # \ * ? [ ]) — what's left is letters,
// digits, spaces, and the punctuation ordinary package names, paths,
// versions and flags use.
const SAFE_VAR_VALUE = /^[A-Za-z0-9 _.,+\/@:^~=-]*$/;

if (!existsSync(MAKEFILE)) {
  console.error(`No Makefile found at ${MAKEFILE}. Set PROJECT_DIR.`);
  process.exit(1);
}

// Resolved once so include-boundary checks compare real paths, not lexical
// ones — a symlinked subdirectory (e.g. `docker_files` pointing outside the
// project) would otherwise pass a plain path.resolve()-based prefix check
// while actually reading from outside PROJECT_DIR.
const PROJECT_DIR_REAL = realpathSync(PROJECT_DIR);

// `--diagnose` runs the same Makefile-parsing this server uses for real,
// then prints a human-readable report of what it found (and, more
// usefully, what it *couldn't* resolve) and exits — no MCP transport, no
// MCP_HTTP_TOKEN required. This is meant to be run directly by a person
// against their own project (`PROJECT_DIR=/path/to/project node
// /path/to/make-runner-mcp/server.js --diagnose`) to check whether their
// Makefile(s) will be read the way they expect *before* wiring the server
// into an agent, rather than discovering a gap only once an agent reports
// a target as missing. See MAKEFILE-GUIDE.md for how to act on each
// section of the report.
if (process.argv.includes("--diagnose")) {
  runDiagnostics();
  process.exit(0);
}

if (MCP_TRANSPORT === "http" && !MCP_HTTP_TOKEN) {
  // Fail closed, loudly, at startup — not on the first request. A network
  // listener that executes commands with no auth at all is the one mistake
  // here that isn't recoverable by a later config fix; refuse to bind the
  // socket rather than start unauthenticated and hope every caller behaves.
  console.error("MCP_TRANSPORT=http requires MCP_HTTP_TOKEN to be set (a long random string). Refusing to start unauthenticated.");
  process.exit(1);
} else if (MCP_TRANSPORT !== "http" && MCP_TRANSPORT !== "stdio") {
  console.error(`Unknown MCP_TRANSPORT '${MCP_TRANSPORT}'. Use 'stdio' (default) or 'http'.`);
  process.exit(1);
}

// Rejects anything that isn't a safe flag or a safe VAR=value assignment.
// Returns an error string, or null if OK.
//
// Bare positional arguments (anything that isn't a flag or VAR=value) are
// rejected outright, not merely character-filtered: make treats a trailing
// bare word as an *additional build goal*, not just data. A character-class
// filter alone would still let a call to an allowed tool smuggle a second,
// denylisted target name onto the same invocation (e.g. `args: ["clean-
// volumes"]` on an allowed target produces `make -f Makefile <allowed>
// clean-volumes`, running both) — bypassing isAllowed() entirely for the
// smuggled goal. Only the single target already vetted by isAllowed() may
// ever be passed as a goal.
function validateArg(a) {
  if (typeof a !== "string" || a.length === 0) return "argument must be a non-empty string";

  if (a.startsWith("-")) {
    return SAFE_FLAGS.has(a) ? null : `flag '${a}' is not permitted`;
  }

  const varMatch = a.match(VAR_ASSIGNMENT);
  if (varMatch) {
    const [, varName, value] = varMatch;
    if (DANGEROUS_VARS.has(varName)) return `variable '${varName}' cannot be overridden`;
    if (!SAFE_VAR_VALUE.test(value)) return `invalid value for '${varName}'`;
    return null;
  }

  return `bare argument '${a}' is not permitted (would be treated as an additional make goal — only flags and VAR=value assignments are allowed)`;
}

function sanitizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === "string");
}

// A broken config must never grant *more* access than no config at all —
// e.g. a malformed `allow` list fails closed to "nothing allowed" rather
// than silently disabling the allowlist. This also guarantees `deny` and
// `allow` are always real string arrays, so isAllowed() below can never be
// handed a non-string entry and throw (that previously took the whole
// server down on every subsequent call, not just the one bad request).
function loadConfig() {
  const empty = { deny: [], allow: null, envAllowlist: null };
  if (!existsSync(CONFIG_PATH)) return empty;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("config must be a JSON object");
    }
    return {
      deny: sanitizeStringArray(raw.deny),
      allow: raw.allow == null ? null : sanitizeStringArray(raw.allow),
      envAllowlist: raw.envAllowlist == null ? null : sanitizeStringArray(raw.envAllowlist),
    };
  } catch (err) {
    console.error(`Failed to parse ${CONFIG_PATH}: ${err.message}`);
    // A file exists but couldn't be understood at all — fail closed on
    // every axis (deny all targets, pass no env vars) rather than
    // guessing which restrictions the operator meant to apply.
    return { deny: [], allow: [], envAllowlist: [] };
  }
}

// Parses real targets out of a Makefile: lines like
//   target: deps ## Optional self-documenting comment
// Skips non-catch-all pattern rules (%.o: %.c, docker-%:, etc.), special
// targets (.PHONY etc.), and variable assignments (which also contain a
// colon, e.g. FOO := bar). Follows include/-include/sinclude directives
// (e.g. a root Makefile pulling in docker/Makefile) so targets defined
// there are discovered too — the real `make` invocation would load them
// anyway via the same directive, so treating them as un-vetted would just
// leave real targets unexposed while offering no actual protection.
//
// Also follows the catch-all forwarding idiom — a bare `%:` rule whose
// recipe recursively invokes `$(MAKE) -C <dir> ...` to forward any goal
// not defined at this level to another directory's Makefile. Real `make`
// already resolves and runs such a forwarded goal correctly through this
// server's existing `make -f <Makefile> <target>` invocation (an explicit
// target always still wins over the pattern rule, same as real `make`);
// the only gap this closes is discovery, so those targets can be listed
// and invoked as MCP tools like any other.
//
// Both of the above are *real* make mechanisms: whatever file this server
// ultimately invokes with `-f <execCtx.file>` will itself load the same
// included/forwarded file the same way, so the target really does exist
// from that invocation's point of view. `execCtx` tracks which file/cwd a
// discovered target should actually be run through — it stays the parent
// call's file/dir for both of these, since that's what real `make` would
// use too.
//
// A third, non-make mechanism exists for projects where a second Makefile
// genuinely isn't reachable via include/forwarding (e.g. the include path
// can't be resolved because it uses a `$(VAR)`, or the second file is a
// wholly separate, independently-invoked Makefile with no real linkage at
// all): a `# make-runner: also-read <path>` (or `##`) comment anywhere in
// the file. This is a hint *to this server*, not to `make` — nothing about
// it changes what `make` itself would do with this file — so a target
// found this way is executed directly against that other file (`-f
// <linked file>`, cwd = its directory), not through execCtx.file. That
// means it won't see variables the root Makefile might otherwise have set
// for it; see MAKEFILE-GUIDE.md for when to reach for this vs. a real
// include/forwarding link.
//
// Every file is resolved to its real (symlink-dereferenced) path before
// being read or boundary-checked, so a symlinked directory pointing
// outside PROJECT_DIR can't be used to smuggle targets from outside the
// project past the "stay inside the project" check below.
// `diag`, when passed (only by runDiagnostics()), is a sink for problems
// that are otherwise silently skipped during normal parsing — an
// unresolvable path is exactly as "not a target" to a real MCP tool call
// either way, but a human running `--diagnose` benefits from being told
// *why* a file it expected to see wasn't read, rather than just seeing it
// missing from the output.
function parseTargetsInto(filePath, targets, visited, depth, execCtx, diag = null) {
  if (depth > MAX_INCLUDE_DEPTH) return;

  let real;
  try {
    real = realpathSync(filePath);
  } catch {
    if (diag) diag.missing.push(filePath);
    return; // doesn't exist, or a broken symlink
  }
  if (real !== PROJECT_DIR_REAL && !real.startsWith(PROJECT_DIR_REAL + path.sep)) {
    if (diag) diag.outsideProject.push(real);
    return;
  }
  if (visited.has(real)) return;
  visited.add(real);

  const fileDir = path.dirname(real);
  const text = readFileSync(real, "utf8");
  const lines = text.split("\n");

  // Directories to forward into, collected here but not resolved until
  // after this file's own loop finishes (see the loop below this one) —
  // so an explicit target declared anywhere in this file always wins over
  // a same-named forwarded target, matching real `make`'s own precedence
  // regardless of whether the `%:` rule appears before or after it.
  const forwardDirs = [];

  // Files named via the `also-read` comment marker, resolved after this
  // file's own loop finishes for the same reason as forwardDirs above: an
  // explicit target defined anywhere in this file wins over one pulled in
  // from a linked file.
  const linkedFiles = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const inc = line.match(/^\s*(?:-|s)?include\s+(.+)$/);
    if (inc) {
      for (const part of inc[1].trim().split(/\s+/)) {
        if (!part) continue;
        if (part.includes("$")) {
          if (diag) diag.unresolvedIncludes.push({ inFile: real, raw: part });
          continue; // can't resolve variable expansions
        }
        const incPath = path.resolve(fileDir, part);
        parseTargetsInto(incPath, targets, visited, depth + 1, execCtx, diag);
      }
      continue;
    }

    // The `also-read` marker: a plain comment, recognized by this server
    // only — it has no effect on what real `make` does with this file.
    // One or more whitespace-separated paths, each resolved relative to
    // this file's own directory (matching how `include` resolves paths).
    const alsoRead = line.match(/^\s*#{1,2}\s*make-runner:\s*also-read\s+(.+)$/);
    if (alsoRead) {
      for (const part of alsoRead[1].trim().split(/\s+/)) {
        if (!part) continue;
        if (part.includes("$")) {
          if (diag) diag.unresolvedAlsoReads.push({ inFile: real, raw: part });
          continue; // can't resolve variable expansions
        }
        let linkedPath = path.resolve(fileDir, part);
        try {
          if (statSync(linkedPath).isDirectory()) linkedPath = path.join(linkedPath, "Makefile");
        } catch {
          // doesn't exist at this exact path — fall through and let the
          // recursive parseTargetsInto's own realpathSync try/catch report
          // it as unreadable, same as any other missing include target.
        }
        linkedFiles.push(linkedPath);
      }
      continue;
    }

    // Matched against the rule part only (everything before make's own
    // comment character, `#` — not specifically `##`; make itself treats
    // a single unescaped `#` as starting a comment on a rule line, and
    // plenty of real Makefiles use single-`#` descriptions rather than
    // this project's own `##` convention). The trailing `[^=]*` below
    // exists to rule out plain variable assignments like `FOO = bar`, but
    // matching it against the *whole* line — comment included — would
    // also reject any genuine target whose trailing comment happens to
    // contain "=" (e.g. `# usage: make composer ARGS="require ..."`),
    // which is exactly the kind of comment the ARGS passthrough
    // convention (see README) encourages people to write. `\#` is treated
    // as an escaped, literal `#` (matching make's own escaping), not a
    // comment start.
    const hashMatch = line.match(/(?<!\\)#/);
    const rulePart = hashMatch ? line.slice(0, hashMatch.index) : line;

    // The catch-all forwarding idiom: a rule whose target is *only* `%`
    // (matches every goal), as opposed to a suffix/prefix pattern rule
    // like `%.o: %.c` or `docker-%:`, which this regex does not match and
    // which falls through to the general target regex below (and is
    // skipped there, as always, since `%` isn't in its character class).
    const catchAll = rulePart.match(/^%\s*:(?!=)(?:[^=]*)$/);
    if (catchAll) {
      // Scan only this rule's own recipe lines — consecutive lines
      // immediately following it that start with a tab, make's own
      // recipe-line convention — stopping at the first line that isn't
      // one. The lazy `[^\n]*?` lets other flags (e.g.
      // `--no-print-directory`) appear before `-C` on the same line.
      let j = i + 1;
      let forwardDir = null;
      while (j < lines.length && /^\t/.test(lines[j])) {
        const mk = lines[j].match(/\$\(MAKE\)[^\n]*?-C\s*"?([^\s"]+)"?/);
        if (mk && !forwardDir) forwardDir = mk[1];
        j++;
      }
      i = j - 1; // resume the outer loop after this rule's recipe lines
      if (forwardDir && !forwardDir.includes("$")) forwardDirs.push(forwardDir); // else: not a forward, or unresolvable variable expansion
      continue;
    }

    const m = rulePart.match(/^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)(?:[^=]*)$/);
    if (!m) continue;
    const name = m[1];
    if (name.startsWith(".")) continue; // .PHONY, .DEFAULT, etc.
    if (targets.has(name)) continue; // first definition wins, like make itself

    const commentMatch = line.match(/##\s*(.+)$/);
    let description = commentMatch ? commentMatch[1].trim() : `Run 'make ${name}'`;
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      description = description.slice(0, MAX_DESCRIPTION_LENGTH) + "…";
    }
    targets.set(name, { description, execFile: execCtx.file, execDir: execCtx.dir });
  }

  for (const dir of forwardDirs) {
    parseTargetsInto(path.resolve(fileDir, dir, "Makefile"), targets, visited, depth + 1, execCtx, diag);
  }

  // Unlike forwardDirs above, each linked file gets its *own* execCtx: it's
  // executed directly (`-f <linked file>`, cwd = its directory), not via
  // execCtx.file, since — being a server-only hint rather than a real make
  // mechanism — real `make -f execCtx.file` would never actually load it.
  for (const linkedPath of linkedFiles) {
    parseTargetsInto(
      linkedPath,
      targets,
      visited,
      depth + 1,
      { file: linkedPath, dir: path.dirname(linkedPath) },
      diag
    );
  }
}

function parseTargets(diag = null) {
  const targets = new Map(); // name -> { description, execFile, execDir }
  parseTargetsInto(MAKEFILE, targets, new Set(), 0, { file: MAKEFILE, dir: PROJECT_DIR }, diag);
  return targets;
}

function isAllowed(name, config) {
  const lower = name.toLowerCase();
  const normalized = lower.replace(/[-_.]/g, "");
  if (HARD_DENY_WORDS.some((d) => normalized.includes(d))) return false;
  if (HARD_DENY_PREFIXES.some((d) => lower.startsWith(d))) return false;
  if (config.deny.some((d) => lower.includes(d.toLowerCase()))) return false;
  if (config.allow && !config.allow.some((a) => a.toLowerCase() === lower)) return false;
  return true;
}

function toolNameFor(target) {
  // MCP tool names: keep it simple/safe, prefix to avoid collisions.
  return `make__${target.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

// Single source of truth for target -> tool name, shared by ListTools and
// CallTool so they can never disagree about which target a call name
// resolves to. Distinct target names that normalize to the same tool name
// (e.g. "foo.bar" and "foo_bar" both -> "make__foo_bar") would otherwise
// silently collide, leaving the second one listed-but-uncallable (or not
// listed at all here) with no indication why — we skip and log instead.
function buildToolEntries(targets, config) {
  const entries = [];
  const usedToolNames = new Set();
  for (const [name, meta] of targets) {
    if (!isAllowed(name, config)) continue;
    const toolName = toolNameFor(name);
    if (usedToolNames.has(toolName)) {
      console.error(
        `Skipping target '${name}': tool name '${toolName}' collides with an already-exposed target.`
      );
      continue;
    }
    usedToolNames.add(toolName);
    entries.push({ targetName: name, toolName, description: meta.description, execFile: meta.execFile, execDir: meta.execDir });
  }
  return entries;
}

// Human-facing report for `--diagnose` (see the flag's own comment above
// for why/when to run it). Automates the parts of MAKEFILE-GUIDE.md that
// this server can actually check for itself — what got discovered, what
// got silently skipped and why, which targets the denylist blocks — so a
// person can see the gap directly instead of having to hand this file to
// an agent and ask it to work through the guide by hand.
function runDiagnostics() {
  const config = loadConfig();
  const diag = { missing: [], outsideProject: [], unresolvedIncludes: [], unresolvedAlsoReads: [] };
  const targets = parseTargets(diag);
  const entries = buildToolEntries(targets, config);
  const exposedNames = new Set(entries.map((e) => e.targetName));

  const lines = [];
  const section = (title) => lines.push("", `-- ${title} --`);

  section(`EXPOSED TARGETS (${entries.length})`);
  if (entries.length === 0) lines.push("none");
  for (const e of entries) {
    const via = e.execFile !== MAKEFILE ? ` [via ${path.relative(PROJECT_DIR, e.execFile)}]` : "";
    const desc = e.description === `Run 'make ${e.targetName}'` ? "MISSING DESCRIPTION — add a `## ...` comment" : e.description;
    lines.push(`${e.targetName}${via}: ${desc}`);
  }

  section("BLOCKED TARGETS (denied by hard denylist or config)");
  const blocked = [...targets.keys()].filter((n) => !exposedNames.has(n));
  if (blocked.length === 0) lines.push("none");
  for (const name of blocked) {
    const lower = name.toLowerCase();
    const normalized = lower.replace(/[-_.]/g, "");
    const hardHit = HARD_DENY_WORDS.find((d) => normalized.includes(d));
    const prefixHit = HARD_DENY_PREFIXES.find((d) => lower.startsWith(d));
    const configDenyHit = config.deny.find((d) => lower.includes(d.toLowerCase()));
    let reason;
    if (hardHit) reason = `hard denylist word '${hardHit}' — CHECK: false positive? see MAKEFILE-GUIDE.md §5`;
    else if (prefixHit) reason = `hard denylist prefix '${prefixHit}' — CHECK: false positive? see MAKEFILE-GUIDE.md §5`;
    else if (configDenyHit) reason = `.mcp-make-config.json deny entry '${configDenyHit}'`;
    else if (config.allow) reason = "not in .mcp-make-config.json's allow list";
    else reason = "blocked (reason unclear — re-check config)";
    lines.push(`${name}: ${reason}`);
  }

  section("UNRESOLVED $(VAR) INCLUDE PATHS (can't be resolved by this server or real `make -f` parsing alone)");
  if (diag.unresolvedIncludes.length === 0) lines.push("none");
  for (const u of diag.unresolvedIncludes) {
    lines.push(`${path.relative(PROJECT_DIR, u.inFile)}: include ${u.raw} — flag as NEEDS HUMAN DECISION per MAKEFILE-GUIDE.md §1`);
  }

  section("UNRESOLVED $(VAR) also-read PATHS");
  if (diag.unresolvedAlsoReads.length === 0) lines.push("none");
  for (const u of diag.unresolvedAlsoReads) {
    lines.push(`${path.relative(PROJECT_DIR, u.inFile)}: also-read ${u.raw} — the also-read marker can't resolve variables either; use a literal relative path`);
  }

  section("FILES REFERENCED BUT NOT FOUND (missing include/also-read target, or broken symlink)");
  if (diag.missing.length === 0) lines.push("none");
  for (const m of diag.missing) lines.push(m);

  section("FILES REJECTED FOR RESOLVING OUTSIDE THE PROJECT (symlink or `../` escape)");
  if (diag.outsideProject.length === 0) lines.push("none");
  for (const o of diag.outsideProject) lines.push(o);

  console.log(`make-runner-mcp diagnostics for PROJECT_DIR=${PROJECT_DIR}`);
  console.log(`Root Makefile: ${MAKEFILE}`);
  console.log(lines.join("\n"));
}

// Serves skills/fix-makefile-links/SKILL.md (the same file distributed for
// manual/Claude-Code-skill installs — see README) as an MCP prompt, so
// simply connecting to this server is enough to get it: no separate file
// to copy into ~/.claude/skills first. One file stays the source of truth
// for the procedure; this just strips the Claude-Code-specific frontmatter
// and prepends the facts this running server already knows (its own
// PROJECT_DIR/Makefile/script path) so whoever receives the prompt doesn't
// need to search for a make-runner-mcp checkout the way a cold read of the
// skill file on its own would require.
function buildFixMakefileLinksPrompt() {
  let raw;
  try {
    raw = readFileSync(FIX_MAKEFILE_LINKS_SKILL_PATH, "utf8");
  } catch (err) {
    console.error(`Failed to read ${FIX_MAKEFILE_LINKS_SKILL_PATH}: ${err.message}`);
    return (
      `Could not load the fix-makefile-links procedure from this server's own ` +
      `checkout (expected at ${FIX_MAKEFILE_LINKS_SKILL_PATH}). Run ` +
      `\`PROJECT_DIR=${PROJECT_DIR} node ${SCRIPT_PATH} --diagnose\` and fix any ` +
      `gaps it reports using MAKEFILE-GUIDE.md's guidance on include/forwarding/` +
      `also-read links.`
    );
  }
  // Strip the leading YAML frontmatter block — it's Claude Code skill
  // metadata (description/argument-hint/allowed-tools), meaningless to a
  // raw MCP prompt message.
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, "");
  const context =
    `You are receiving this as an MCP prompt served directly by the ` +
    `make-runner-mcp server already configured for this project — you ` +
    `already have everything Step 5 asks you to go find:\n\n` +
    `Project root (PROJECT_DIR): ${PROJECT_DIR}\n` +
    `Root Makefile: ${MAKEFILE}\n` +
    `This server's own script, for Step 5's live verification: ${SCRIPT_PATH}\n` +
    `  e.g. PROJECT_DIR="${PROJECT_DIR}" node "${SCRIPT_PATH}" --diagnose\n\n` +
    `---\n\n`;
  return context + body;
}

// By default the child inherits the full parent environment, which in an
// agent sandbox often carries API keys/tokens — those become readable (and
// echoable back into the tool result) by every recipe. Projects that want
// to narrow this can set `envAllowlist` in .mcp-make-config.json; absent
// that, behavior is unchanged from before (full passthrough) so this is
// opt-in hardening, not a breaking change.
//
// PATH always passes through, even when omitted from envAllowlist: Node
// resolves the `make` executable itself using PATH from the *child's* env
// (not the parent's), and recipes almost universally invoke bare command
// names (npm, git, gcc, ...) that likewise need PATH to resolve. Without
// this, narrowing envAllowlist to anything that forgets PATH would break
// every tool call outright rather than actually narrowing exposure.
function buildChildEnv(config) {
  if (!config.envAllowlist) return { ...process.env };
  const env = {};
  for (const key of config.envAllowlist) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (env.PATH === undefined && process.env.PATH !== undefined) {
    env.PATH = process.env.PATH;
  }
  return env;
}

function runMake(targetArgs, label, config, cwd = PROJECT_DIR) {
  return new Promise((resolve) => {
    // detached:true makes `child` a process-group leader (POSIX) so a
    // timeout can terminate the whole tree, not just the immediate `make`
    // process — otherwise a recipe that backgrounds work (e.g. `foo &`)
    // can outlive both the timeout and the tool call that started it.
    const child = spawn("make", targetArgs, {
      cwd,
      shell: false,
      detached: process.platform !== "win32",
      env: buildChildEnv(config),
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;

    const killTree = (signal) => {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // already exited
      }
    };

    // Tracked separately from `timer` so a child that exits cleanly within
    // the SIGTERM grace period cancels the pending SIGKILL too — otherwise
    // it fires later against whatever process the OS has since reused
    // `child.pid` for.
    let killTimer = null;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      killTimer = setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS);
    }, TIMEOUT_MS);

    const appendCapped = (buf, chunk) => {
      if (buf.length >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return buf;
      }
      const s = chunk.toString();
      if (buf.length + s.length > MAX_OUTPUT_BYTES) {
        truncated = true;
        return buf + s.slice(0, MAX_OUTPUT_BYTES - buf.length);
      }
      return buf + s;
    };

    child.stdout.on("data", (c) => {
      stdout = appendCapped(stdout, c);
    });
    child.stderr.on("data", (c) => {
      stderr = appendCapped(stderr, c);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        content: [
          {
            type: "text",
            text:
              `$ make ${targetArgs.join(" ")} (${label})\n` +
              `exit code: ${code}\n\n--- stdout ---\n${stdout}\n` +
              (stderr ? `--- stderr ---\n${stderr}\n` : "") +
              (truncated ? "\n[output truncated]\n" : "") +
              (timedOut ? `\n[timed out after ${TIMEOUT_MS / 1000}s, process group terminated]\n` : ""),
          },
        ],
        isError: code !== 0 || timedOut,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        content: [{ type: "text", text: `Failed to start make: ${err.message}` }],
        isError: true,
      });
    });
  });
}

// A fresh Server instance per connection, not a shared singleton — the SDK's
// Server/Protocol object represents one connected session (this is implicit
// in stdio, where there's inherently only ever one client, but explicit
// once there can be several concurrent HTTP sessions: reusing one Server
// across multiple transport.connect() calls produces "Server already
// initialized" on the second session's handshake). Cheap to construct —
// all the real state (Makefile/config) is re-read fresh on every request
// regardless, per the re-parse-on-every-call design above — so there's no
// cost to this beyond the one-time setup below.
function createServer() {
  const server = new Server(
    { name: "make-runner", version: "2.0.0" },
    { capabilities: { tools: {}, prompts: {} } }
  );

  // Both handlers below are wrapped in try/catch as a last line of defense:
  // no single bad input (a malformed config, an unreadable include, or a bug
  // we haven't thought of) should be able to take down every future request.
  // Fail closed — log the real error server-side, tell the caller nothing
  // more than "rejected"/"no tools" — rather than let an exception propagate
  // as a raw JSON-RPC error that both breaks subsequent calls and can leak
  // internal detail back to the caller.

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const config = loadConfig();
      const targets = parseTargets();
      const tools = buildToolEntries(targets, config).map(({ targetName, toolName, description, execFile }) => {
        // Flag targets reached only via the `also-read` marker (not a real
        // make include/forwarding) so a calling agent understands this
        // target runs against a separate Makefile, with its own directory
        // as cwd — it won't see variables the root Makefile might set.
        const viaNote = execFile !== MAKEFILE ? `, via ${path.relative(PROJECT_DIR, execFile)}` : "";
        return {
          name: toolName,
          description: `${description} (make target: ${targetName}${viaNote})`,
          inputSchema: {
            type: "object",
            properties: {
              args: {
                type: "array",
                items: { type: "string" },
                description: "Optional extra make flags and/or VAR=value pairs (e.g. ARGS=\"install symfony/console --no-dev\" for a target whose recipe uses $(ARGS)). No bare positional arguments — those would be treated as additional build goals.",
              },
            },
            additionalProperties: false,
          },
        };
      });
      return { tools };
    } catch (err) {
      console.error(`ListTools failed: ${err.stack || err.message}`);
      return { tools: [] };
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name: toolName, arguments: callArgs = {} } = request.params;

      // Re-parse fresh on every call — never trust a cached mapping, so a
      // Makefile edited between listing and calling can't be exploited to
      // sneak a now-denied target through under an old tool name.
      const config = loadConfig();
      const targets = parseTargets();

      const match = buildToolEntries(targets, config).find((t) => t.toolName === toolName);
      if (!match) {
        return {
          content: [{ type: "text", text: `Rejected: '${toolName}' is not a currently allowed target.` }],
          isError: true,
        };
      }

      const extra = callArgs.args || [];
      for (const a of extra) {
        const err = validateArg(a);
        if (err) {
          return {
            content: [{ type: "text", text: `Rejected: ${err}.` }],
            isError: true,
          };
        }
      }

      // -f pins make to exactly the file we parsed and vetted `match` against
      // — no argument path (allowlisted or not) can override this. For most
      // targets that's the root MAKEFILE (real make will load whatever it
      // includes/forwards to); for a target reached only via the
      // `also-read` marker, match.execFile is that other file directly, run
      // from its own directory (match.execDir), matching how it'd actually
      // be invoked by hand.
      return await runMake(
        ["-f", match.execFile, match.targetName, ...extra],
        `target: ${match.targetName}`,
        config,
        match.execDir
      );
    } catch (err) {
      console.error(`CallTool failed: ${err.stack || err.message}`);
      return {
        content: [{ type: "text", text: "Rejected: internal error handling this request." }],
        isError: true,
      };
    }
  });

  // A single prompt, "fix-makefile-links": see buildFixMakefileLinksPrompt()
  // above for what it actually serves and why. This is what makes it
  // reachable to any MCP client without a separate skill-file install —
  // connecting to this server is enough.
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: "fix-makefile-links",
        description:
          "Find every Makefile in this project, check which ones make-runner-mcp can " +
          "actually discover, and add the missing `also-read` link automatically for " +
          "any that are orphaned — instead of just reporting the gap.",
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name } = request.params;
    if (name !== "fix-makefile-links") {
      throw new Error(`Unknown prompt: ${name}`);
    }
    return {
      description: "Diagnose and fix why make-runner-mcp isn't discovering a secondary Makefile's targets.",
      messages: [
        {
          role: "user",
          content: { type: "text", text: buildFixMakefileLinksPrompt() },
        },
      ],
    };
  });

  return server;
}

if (MCP_TRANSPORT === "http") {
  // Session id -> transport. A new client (no mcp-session-id header, an
  // `initialize` request) gets its own fresh Server+Transport pair; every
  // later request for that session is routed to the same transport, per
  // the SDK's own documented multi-session pattern (see
  // examples/server/simpleStreamableHttp.js) — reusing a single
  // Server/transport across sessions produces "Server already initialized"
  // on the second session's handshake, since a Server represents one
  // connected session, not a process-wide singleton.
  const sessions = new Map(); // sessionId -> { transport, lastSeen }

  const sweepIdleSessions = () => {
    const cutoff = Date.now() - SESSION_IDLE_TIMEOUT_MS;
    for (const [sid, entry] of sessions) {
      if (entry.lastSeen < cutoff) {
        sessions.delete(sid);
        try {
          entry.transport.close();
        } catch (err) {
          console.error(`Error closing idle session ${sid}: ${err.stack || err.message}`);
        }
      }
    }
  };
  const sweepTimer = setInterval(sweepIdleSessions, SESSION_SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  const expectedAuth = `Bearer ${MCP_HTTP_TOKEN}`;

  function isAuthorized(req) {
    const authHeader = req.headers["authorization"] || "";
    // Constant-time comparison, and a length check first since
    // timingSafeEqual throws (rather than returning false) on a length
    // mismatch — a naive `authHeader === expected` would otherwise leak
    // the token's length via response-time differences.
    const authBuf = Buffer.from(authHeader);
    const expectedBuf = Buffer.from(expectedAuth);
    return authBuf.length === expectedBuf.length && timingSafeEqual(authBuf, expectedBuf);
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        if (!raw) return resolve(undefined);
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(err);
        }
      });
      req.on("error", reject);
    });
  }

  const httpServer = createHttpServer(async (req, res) => {
    if (!isAuthorized(req)) {
      res.writeHead(401, { "content-type": "application/json" }).end(
        JSON.stringify({ error: "unauthorized" })
      );
      return;
    }

    const sessionId = req.headers["mcp-session-id"];

    try {
      if (sessionId && sessions.has(sessionId)) {
        const entry = sessions.get(sessionId);
        entry.lastSeen = Date.now();
        await entry.transport.handleRequest(req, res, req.method === "POST" ? await readJsonBody(req) : undefined);
        return;
      }

      if (req.method === "POST" && !sessionId) {
        const body = await readJsonBody(req);
        if (!isInitializeRequest(body)) {
          res.writeHead(400, { "content-type": "application/json" }).end(
            JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No valid session ID provided" }, id: null })
          );
          return;
        }
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => sessions.set(sid, { transport, lastSeen: Date.now() }),
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await createServer().connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      res.writeHead(400, { "content-type": "application/json" }).end(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No valid session ID provided" }, id: null })
      );
    } catch (err) {
      console.error(`HTTP transport error: ${err.stack || err.message}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  httpServer.listen(MCP_HTTP_PORT, MCP_HTTP_HOST, () => {
    console.error(`make-runner-mcp listening on http://${MCP_HTTP_HOST}:${MCP_HTTP_PORT} (MCP_HTTP_TOKEN required)`);
  });
} else {
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
}
