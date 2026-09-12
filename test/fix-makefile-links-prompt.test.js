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

test("the fix-makefile-links prompt is listed and served with this project's own facts filled in", async () => {
  const fixture = path.join(__dirname, "fixtures", "also-read");
  const { child, send } = await initialized(fixture);
  try {
    const list = await send("prompts/list", {});
    assert.ok(
      list.result.prompts.some((p) => p.name === "fix-makefile-links"),
      "fix-makefile-links prompt is advertised"
    );

    const got = await send("prompts/get", { name: "fix-makefile-links" });
    const text = got.result.messages[0].content.text;
    assert.ok(!text.startsWith("---\n"), "Claude Code skill frontmatter was stripped");
    assert.match(text, /Project root \(PROJECT_DIR\): .*fixtures\/also-read/, "this project's own PROJECT_DIR is filled in");
    assert.match(text, /Root Makefile: .*fixtures\/also-read\/Makefile/, "this project's own Makefile path is filled in");
    assert.match(text, /server\.js/, "points back at this server's own script for live verification");
    assert.match(text, /## Step 1/, "the actual procedure body is included");
  } finally {
    child.kill();
  }
});

test("prompts/get rejects an unknown prompt name", async () => {
  const fixture = path.join(__dirname, "fixtures", "also-read");
  const { child, send } = await initialized(fixture);
  try {
    const got = await send("prompts/get", { name: "not-a-real-prompt" });
    assert.ok(got.error, "an unknown prompt name is a JSON-RPC error, not a silent empty result");
  } finally {
    child.kill();
  }
});
