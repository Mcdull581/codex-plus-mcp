import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Support running both inside repo (`test/test-mcp.mjs`) and deployed (`~/.codex-plus-mcp/test-mcp.mjs`)
const serverPath = fs.existsSync(path.join(__dirname, "server.mjs"))
  ? path.join(__dirname, "server.mjs")
  : path.resolve(__dirname, "..", "src", "server.mjs");

const setupScriptPath = fs.existsSync(path.join(__dirname, "scripts", "setup.mjs"))
  ? path.join(__dirname, "scripts", "setup.mjs")
  : path.resolve(__dirname, "..", "scripts", "setup.mjs");

function createMcpClient(envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  const child = spawn(process.execPath, [serverPath], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => process.stderr.write(`[server stderr] ${d}`));

  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const msg = JSON.parse(trimmed);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  let nextId = 1;
  function rpc(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 10000);
      pending.set(id, (res) => {
        clearTimeout(t);
        resolve(res);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  function notify(method, params = {}) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  function close() {
    try {
      rl.close();
    } catch {}
    try {
      child.kill();
    } catch {}
  }

  return { rpc, notify, close };
}

function extractJsonBlock(text) {
  const m = text.match(/```json\s*([\s\S]*?)```/);
  if (!m) throw new Error("Expected JSON code block in tool output");
  return JSON.parse(m[1]);
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Suite A: Protocol Handshake, Tool Schemas, Ranking, Concurrency & Guards
// ---------------------------------------------------------------------------
async function runIsolatedServerSuite() {
  const tmpHome = path.join(os.tmpdir(), `codex-mcp-oss-test-${crypto.randomUUID()}`);
  const nonGitDir = path.join(tmpHome, "plain-folder");
  fs.mkdirSync(nonGitDir, { recursive: true });

  for (const acc of ["plus-1", "plus-2", "plus-3"]) {
    const dir = path.join(tmpHome, "accounts", acc);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.toml"), 'cli_auth_credentials_store = "file"\n', "utf8");
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ mock_token: "ok_1234567890" }), "utf8");
  }

  const futureCooldown = new Date(Date.now() + 20 * 60 * 1000).toISOString();
  const mockRegistry = {
    version: 4,
    accounts: {
      "plus-1": {
        label: "personal",
        defaultModel: "",
        lastUsedAt: "2026-11-24T10:00:00.000Z",
        callCount: 5,
        totalTokens: 10000,
        lastQuota: {
          fetchedAt: new Date().toISOString(),
          primary: { usedPercent: 40, remainingPercent: 60 },
          secondary: { usedPercent: 30, remainingPercent: 70 },
        },
        cooldownUntil: null,
        lastError: null,
        recentSessions: [],
      },
      "plus-2": {
        label: "work",
        defaultModel: "",
        lastUsedAt: "2026-11-24T09:00:00.000Z",
        callCount: 2,
        totalTokens: 4000,
        lastQuota: {
          fetchedAt: new Date().toISOString(),
          primary: { usedPercent: 99, remainingPercent: 1 },
          secondary: { usedPercent: 10, remainingPercent: 90 },
        },
        cooldownUntil: futureCooldown,
        lastError: "429",
        recentSessions: [],
      },
      "plus-3": {
        label: "backup",
        defaultModel: "",
        lastUsedAt: "2026-11-24T08:00:00.000Z",
        callCount: 1,
        totalTokens: 1500,
        lastQuota: {
          fetchedAt: new Date().toISOString(),
          primary: { usedPercent: 5, remainingPercent: 95 },
          secondary: { usedPercent: 12, remainingPercent: 88 },
        },
        cooldownUntil: null,
        lastError: null,
        recentSessions: [],
      },
    },
  };
  fs.writeFileSync(path.join(tmpHome, "accounts.json"), JSON.stringify(mockRegistry, null, 2), "utf8");

  const client = createMcpClient({ CODEX_BRIDGE_HOME: tmpHome, DEEPSEEK_API_KEY: "" });
  try {
    const initRes = await client.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "oss-test", version: "3.2.0" },
    });
    assert(initRes.result?.serverInfo?.name === "codex-plus-bridge", "serverInfo.name mismatch");
    assert(initRes.result?.serverInfo?.version === "3.2.0", "serverInfo.version mismatch");
    console.log("[PASS] initialize: codex-plus-bridge@3.2.0");

    client.notify("notifications/initialized");

    const listRes = await client.rpc("tools/list");
    const tools = listRes.result?.tools || [];
    const toolNames = tools.map((t) => t.name);
    for (const req of [
      "codex_list_accounts",
      "codex_manage_account",
      "codex_exec",
      "codex_resume",
      "codex_review",
      "deepseek_ask",
      "deepseek_search",
    ]) {
      assert(toolNames.includes(req), `missing tool ${req}`);
    }
    const execProps = tools.find((t) => t.name === "codex_exec").inputSchema.properties;
    assert(execProps.images && execProps.worktree && execProps.tier && execProps.reasoning_effort, "missing v3.2 schema props");
    console.log("[PASS] tools/list & v3.2 schemas verified (7 tools)");

    const rankRes = await client.rpc("tools/call", {
      name: "codex_list_accounts",
      arguments: { check_live_status: false, include_live_quota: false },
    });
    const rankData = extractJsonBlock(rankRes.result.content[0].text);
    assert(rankData.recommendedAccount === "plus-3", `expected plus-3, got ${rankData.recommendedAccount}`);
    assert(rankData.accounts[0].account === "plus-3", "rank 1 mismatch");
    assert(rankData.accounts[1].account === "plus-1", "rank 2 mismatch");
    assert(rankData.accounts[2].account === "plus-2", "cooling account should be last");
    assert(rankData.modelTiers?.economy?.model === "gpt-6-luna", "economy tier mismatch");
    assert(rankData.modelTiers?.balanced?.model === "gpt-6.2-sol", "balanced tier mismatch");
    assert(rankData.modelTiers?.flagship?.model === "gpt-6.2-astra", "flagship tier mismatch");
    assert(rankData.modelTiers?.vision?.model === "gpt-6.1-terra", "vision tier mismatch");
    console.log("[PASS] recommendedAccount ranking & modelTiers verified");

    const mutations = await Promise.all([
      client.rpc("tools/call", { name: "codex_manage_account", arguments: { action: "set_note", account: "plus-1", value: "personal-v2" } }),
      client.rpc("tools/call", { name: "codex_manage_account", arguments: { action: "set_model", account: "plus-2", value: "gpt-6.2-sol" } }),
      client.rpc("tools/call", { name: "codex_manage_account", arguments: { action: "set_note", account: "plus-3", value: "backup-v2" } }),
      client.rpc("tools/call", { name: "codex_manage_account", arguments: { action: "clear_cooldown", account: "plus-2" } }),
      client.rpc("tools/call", { name: "codex_manage_account", arguments: { action: "add_account", account: "plus-4", value: "extra" } }),
    ]);
    for (const m of mutations) assert(!m.result?.isError, "concurrent mutation failed");
    const afterDisk = JSON.parse(fs.readFileSync(path.join(tmpHome, "accounts.json"), "utf8"));
    assert(afterDisk.accounts["plus-1"].label === "personal-v2", "plus-1 update lost");
    assert(afterDisk.accounts["plus-2"].defaultModel === "gpt-6.2-sol", "plus-2 model lost");
    assert(afterDisk.accounts["plus-2"].cooldownUntil === null, "plus-2 cooldown not cleared");
    assert(afterDisk.accounts["plus-3"].label === "backup-v2", "plus-3 update lost");
    assert(afterDisk.accounts["plus-4"]?.label === "extra", "plus-4 add lost");
    console.log("[PASS] concurrent atomic mutateRegistry verified (5 parallel updates)");

    const badImg = await client.rpc("tools/call", {
      name: "codex_exec",
      arguments: { account: "plus-1", prompt: "check", images: [path.join(tmpHome, "missing.png")] },
    });
    assert(Boolean(badImg.result?.isError), "missing image should fail");
    console.log("[PASS] images validation guard verified");

    const badWt = await client.rpc("tools/call", {
      name: "codex_exec",
      arguments: { account: "plus-1", prompt: "edit", working_dir: nonGitDir, worktree: true },
    });
    assert(Boolean(badWt.result?.isError), "worktree on non-git should fail");
    console.log("[PASS] worktree Git-repo guard verified");

    const dsAsk = await client.rpc("tools/call", { name: "deepseek_ask", arguments: { prompt: "hi" } });
    const dsSearch = await client.rpc("tools/call", { name: "deepseek_search", arguments: { query: "test" } });
    assert(Boolean(dsAsk.result?.isError) && dsAsk.result.content[0].text.includes("deepseek.json"), "deepseek_ask guard failed");
    assert(Boolean(dsSearch.result?.isError) && dsSearch.result.content[0].text.includes("DEEPSEEK_API_KEY"), "deepseek_search guard failed");
    console.log("[PASS] DeepSeek unconfigured-key guards verified");
  } finally {
    client.close();
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Suite B: Setup Wizard Account Onboarding Test (Isolated Temp Dir)
// ---------------------------------------------------------------------------
function runSetupWizardSuite() {
  if (!fs.existsSync(setupScriptPath)) return;
  const tmpTarget = path.join(os.tmpdir(), `codex-setup-test-${crypto.randomUUID()}`);
  try {
    const accountsArg = JSON.stringify([
      { id: "acc-main", label: "Personal", defaultModel: "" },
      { id: "acc-alt", label: "Work", defaultModel: "gpt-6.2-sol" },
    ]);
    const res = spawnSync(
      process.execPath,
      [
        setupScriptPath,
        "--non-interactive",
        "--target",
        tmpTarget,
        "--accounts",
        accountsArg,
        "--skip-auth",
        "--skip-antigravity",
        "--skip-test",
      ],
      { encoding: "utf8" }
    );
    assert(res.status === 0, `setup.mjs exited with ${res.status}: ${res.stderr}`);
    assert(fs.existsSync(path.join(tmpTarget, "server.mjs")), "deployed server.mjs missing");
    assert(fs.existsSync(path.join(tmpTarget, "accounts", "acc-main", "config.toml")), "acc-main config.toml missing");
    assert(fs.existsSync(path.join(tmpTarget, "accounts", "acc-alt", "config.toml")), "acc-alt config.toml missing");

    const regBuf = fs.readFileSync(path.join(tmpTarget, "accounts.json"));
    assert(!(regBuf[0] === 0xef && regBuf[1] === 0xbb && regBuf[2] === 0xbf), "accounts.json should have no BOM");
    const reg = JSON.parse(regBuf.toString("utf8"));
    assert(reg.accounts["acc-main"]?.label === "Personal", "acc-main label mismatch");
    assert(reg.accounts["acc-alt"]?.label === "Work", "acc-alt label mismatch");
    assert(reg.accounts["acc-alt"]?.defaultModel === "gpt-6.2-sol", "acc-alt model mismatch");
    console.log("[PASS] setup.mjs onboarding wizard verified (account data entry + isolated CODEX_HOME creation)");
  } finally {
    try {
      fs.rmSync(tmpTarget, { recursive: true, force: true });
    } catch {}
  }
}

await runIsolatedServerSuite();
runSetupWizardSuite();
console.log("\nALL STANDALONE MCP TESTS PASSED!");
