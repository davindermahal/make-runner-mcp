#!/usr/bin/env node
/**
 * make-runner MCP server (dynamic)
 *
 * Parses the project's own Makefile (following any `include`/`-include`
 * directives, e.g. a root Makefile pulling in `docker/Makefile`) and
 * exposes one MCP tool per discovered target. Nothing is exposed or
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
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

const PROJECT_DIR = path.resolve(process.env.PROJECT_DIR || process.cwd());
const MAKEFILE = path.join(PROJECT_DIR, "Makefile");
const CONFIG_PATH =
  process.env.MCP_MAKE_CONFIG || path.join(PROJECT_DIR, ".mcp-make-config.json");
const TIMEOUT_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 5000;
const MAX_OUTPUT_BYTES = 200_000;
const MAX_INCLUDE_DEPTH = 8;
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
// Skips pattern rules (%), special targets (.PHONY etc.), and variable
// assignments (which also contain a colon, e.g. FOO := bar). Follows
// include/-include/sinclude directives (e.g. a root Makefile pulling in
// docker/Makefile) so targets defined there are discovered too — the real
// `make` invocation would load them anyway via the same directive, so
// treating them as un-vetted would just leave real targets unexposed
// while offering no actual protection.
//
// Every file is resolved to its real (symlink-dereferenced) path before
// being read or boundary-checked, so a symlinked directory pointing
// outside PROJECT_DIR can't be used to smuggle targets from outside the
// project past the "stay inside the project" check below.
function parseTargetsInto(filePath, targets, visited, depth) {
  if (depth > MAX_INCLUDE_DEPTH) return;

  let real;
  try {
    real = realpathSync(filePath);
  } catch {
    return; // doesn't exist, or a broken symlink
  }
  if (real !== PROJECT_DIR_REAL && !real.startsWith(PROJECT_DIR_REAL + path.sep)) return;
  if (visited.has(real)) return;
  visited.add(real);

  const fileDir = path.dirname(real);
  const text = readFileSync(real, "utf8");
  const lines = text.split("\n");

  for (const line of lines) {
    const inc = line.match(/^\s*(?:-|s)?include\s+(.+)$/);
    if (inc) {
      for (const part of inc[1].trim().split(/\s+/)) {
        if (!part || part.includes("$")) continue; // can't resolve variable expansions
        const incPath = path.resolve(fileDir, part);
        parseTargetsInto(incPath, targets, visited, depth + 1);
      }
      continue;
    }

    // Matched against the rule part only (everything before a `##`
    // comment, if any) — the trailing `[^=]*` here exists to rule out
    // plain variable assignments like `FOO = bar`, but matching it against
    // the *whole* line would also reject genuine targets whose comment
    // text happens to contain "=" (e.g. `## e.g. ARGS="install ..."`),
    // which is exactly the kind of comment the ARGS passthrough
    // convention (see README) encourages people to write.
    const hashIdx = line.indexOf("##");
    const rulePart = hashIdx === -1 ? line : line.slice(0, hashIdx);

    const m = rulePart.match(/^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)(?:[^=]*)$/);
    if (!m) continue;
    const name = m[1];
    if (name.startsWith(".")) continue; // .PHONY, .DEFAULT, etc.
    if (name.includes("%")) continue; // pattern rules
    if (targets.has(name)) continue; // first definition wins, like make itself

    const commentMatch = line.match(/##\s*(.+)$/);
    let description = commentMatch ? commentMatch[1].trim() : `Run 'make ${name}'`;
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      description = description.slice(0, MAX_DESCRIPTION_LENGTH) + "…";
    }
    targets.set(name, description);
  }
}

function parseTargets() {
  const targets = new Map(); // name -> description
  parseTargetsInto(MAKEFILE, targets, new Set(), 0);
  return targets;
}

function isAllowed(name, config) {
  const lower = name.toLowerCase();
  const normalized = lower.replace(/[-_.]/g, "");
  if (HARD_DENY_WORDS.some((d) => normalized.includes(d))) return false;
  if (HARD_DENY_PREFIXES.some((d) => lower.startsWith(d))) return false;
  if (config.deny.some((d) => lower.includes(d.toLowerCase()))) return false;
  if (config.allow && !config.allow.includes(name)) return false;
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
  for (const [name, description] of targets) {
    if (!isAllowed(name, config)) continue;
    const toolName = toolNameFor(name);
    if (usedToolNames.has(toolName)) {
      console.error(
        `Skipping target '${name}': tool name '${toolName}' collides with an already-exposed target.`
      );
      continue;
    }
    usedToolNames.add(toolName);
    entries.push({ targetName: name, toolName, description });
  }
  return entries;
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

function runMake(targetArgs, label, config) {
  return new Promise((resolve) => {
    // detached:true makes `child` a process-group leader (POSIX) so a
    // timeout can terminate the whole tree, not just the immediate `make`
    // process — otherwise a recipe that backgrounds work (e.g. `foo &`)
    // can outlive both the timeout and the tool call that started it.
    const child = spawn("make", targetArgs, {
      cwd: PROJECT_DIR,
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

    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS);
    }, TIMEOUT_MS);

    child.stdout.on("data", (c) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += c.toString();
      else truncated = true;
    });
    child.stderr.on("data", (c) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += c.toString();
      else truncated = true;
    });

    child.on("close", (code) => {
      clearTimeout(timer);
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

const server = new Server(
  { name: "make-runner", version: "2.0.0" },
  { capabilities: { tools: {} } }
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
    const tools = buildToolEntries(targets, config).map(({ targetName, toolName, description }) => ({
      name: toolName,
      description: `${description} (make target: ${targetName})`,
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
    }));
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
    // — no argument path (allowlisted or not) can override this.
    return await runMake(["-f", MAKEFILE, match.targetName, ...extra], `target: ${match.targetName}`, config);
  } catch (err) {
    console.error(`CallTool failed: ${err.stack || err.message}`);
    return {
      content: [{ type: "text", text: "Rejected: internal error handling this request." }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
