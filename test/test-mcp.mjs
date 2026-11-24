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
// Suite A: Isolated Server Functional Suite (v3.3.0)
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
      clientInfo: { name: "oss-test", version: "3.3.0" },
    });
    assert(initRes.result?.serverInfo?.name === "codex-plus-bridge", "serverInfo.name mismatch");
    assert(initRes.result?.serverInfo?.version === "3.3.0", `expected 3.3.0, got ${initRes.result?.serverInfo?.version}`);
    console.log("[PASS] initialize: codex-plus-bridge@3.3.0");

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
      "codex_generate_image",
      "deepseek_ask",
      "deepseek_search",
    ]) {
      assert(toolNames.includes(req), `missing tool ${req}`);
    }
    const execProps = tools.find((t) => t.name === "codex_exec").inputSchema.properties;
    assert(execProps.images && execProps.worktree && execProps.tier && execProps.reasoning_effort, "missing codex_exec props");
    const genProps = tools.find((t) => t.name === "codex_generate_image").inputSchema.properties;
    assert(genProps.account && genProps.prompt && genProps.output_path && genProps.reference_images && genProps.transparent_background, "missing codex_generate_image props");
    console.log("[PASS] tools/list & v3.3.0 schemas verified (8 tools)");

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

    const emptyGen = await client.rpc("tools/call", {
      name: "codex_generate_image",
      arguments: { account: "plus-1", prompt: "  " },
    });
    assert(Boolean(emptyGen.result?.isError), "empty prompt should fail");
    const badRefGen = await client.rpc("tools/call", {
      name: "codex_generate_image",
      arguments: { account: "plus-1", prompt: "restyle", reference_images: [path.join(tmpHome, "missing-ref.png")] },
    });
    assert(Boolean(badRefGen.result?.isError), "missing reference image should fail");
    console.log("[PASS] codex_generate_image input guards verified");
  } finally {
    client.close();
  }

  // End-to-end mock Codex CLI test for `-i ... -- -`, `--enable image_generation`, file copy & forced quota
  const mockCodexJs = path.join(tmpHome, "mock-codex.cjs");
  const sampleRefImg = path.join(tmpHome, "ref-input.png");
  const targetOutImg = path.join(tmpHome, "out", "final-figure.png");
  fs.writeFileSync(sampleRefImg, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  fs.writeFileSync(
    mockCodexJs,
    `
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
if (args[0] === "app-server") {
  process.stdin.on("data", (buf) => {
    const lines = buf.toString("utf8").split(/\\r?\\n/).filter(Boolean);
    for (const line of lines) {
      const m = JSON.parse(line);
      if (m.id === 1) {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }) + "\\n");
      } else if (m.id === 2) {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: {
            ordinaryUsageAllowed: true,
            rateLimits: {
              planType: "plus",
              primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: Math.floor(Date.now()/1000) + 7200 },
              secondary: { usedPercent: 22, windowDurationMins: 10080, resetsAt: Math.floor(Date.now()/1000) + 86400 }
            }
          }
        }) + "\\n");
      }
    }
  });
  return;
}
const idxI = args.indexOf("-i");
const idxDashDash = args.indexOf("--");
const idxStdin = args.lastIndexOf("-");
if (idxI === -1 || idxDashDash === -1 || !(idxI < idxDashDash && idxDashDash < idxStdin)) {
  console.error("Invalid -i / -- / - order: " + JSON.stringify(args));
  process.exit(2);
}
if (!args.includes("--enable") || !args.includes("image_generation")) {
  console.error("Missing --enable image_generation: " + JSON.stringify(args));
  process.exit(3);
}
const outIdx = args.indexOf("-o");
const outTxt = outIdx >= 0 ? args[outIdx + 1] : null;
const genDir = path.join(process.env.CODEX_HOME, "generated_images", "thread-img-test");
fs.mkdirSync(genDir, { recursive: true });
const genPng = path.join(genDir, "ig_001.png");
fs.writeFileSync(genPng, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42]));
if (outTxt) fs.writeFileSync(outTxt, "Generated diagram successfully.", "utf8");
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-img-test" }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "item.completed",
  item: {
    type: "imageGeneration",
    id: "ig_1",
    status: "completed",
    savedPath: genPng,
    revisedPrompt: "Clean academic vector schematic"
  }
}) + "\\n");
process.stdout.write(JSON.stringify({
  type: "turn.completed",
  usage: { input_tokens: 1200, cached_input_tokens: 200, output_tokens: 350, total_tokens: 1550 }
}) + "\\n");
process.exit(0);
`,
    "utf8"
  );

  const mockClient = createMcpClient({
    CODEX_BRIDGE_HOME: tmpHome,
    CODEX_JS_PATH: mockCodexJs,
    DEEPSEEK_API_KEY: "",
  });
  try {
    await mockClient.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mock-image-test", version: "3.3.0" },
    });
    mockClient.notify("notifications/initialized");

    const genRes = await mockClient.rpc("tools/call", {
      name: "codex_generate_image",
      arguments: {
        account: "plus-1",
        prompt: "Redraw this schematic in clean academic style",
        reference_images: [sampleRefImg],
        output_path: targetOutImg,
        size: "1536x1024",
        quality: "high",
      },
    });
    assert(!genRes.result?.isError, `mock codex_generate_image failed: ${genRes.result?.content?.[0]?.text}`);
    assert(fs.existsSync(targetOutImg), "generated image not copied to output_path");
    const outText = genRes.result.content[0].text;
    const metaMatch = outText.match(/<!-- subagent_meta:(\{[\s\S]*?\}) -->/);
    assert(Boolean(metaMatch), "missing subagent_meta");
    const meta = JSON.parse(metaMatch[1]);
    assert(meta.provider === "codex-plus-image", "wrong provider tag");
    assert(meta.imageCount === 1, "expected imageCount=1");
    assert(meta.generatedFiles?.[0] === path.resolve(targetOutImg), "generatedFiles mismatch");
    assert(meta.quota?.primary?.usedPercent === 18, "forced live quota mismatch");
    console.log("[PASS] end-to-end -i -- - + --enable image_generation + copy + forced quota verified");
  } finally {
    mockClient.close();
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
    console.log("[PASS] setup.mjs onboarding wizard verified (account entry + isolated CODEX_HOME)");
  } finally {
    try {
      fs.rmSync(tmpTarget, { recursive: true, force: true });
    } catch {}
  }
}

await runIsolatedServerSuite();
runSetupWizardSuite();
console.log("\nALL STANDALONE v3.3.0 MCP TESTS PASSED!");
