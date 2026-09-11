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
