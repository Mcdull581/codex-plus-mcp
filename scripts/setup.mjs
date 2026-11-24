#!/usr/bin/env node
/**
 * Interactive Setup & Onboarding Wizard for Codex Plus MCP (Cross-platform, Zero-Dependency)
 *
 * Features:
 * 1. Environment check (Node.js >= 20, @openai/codex CLI)
 * 2. Deploy runtime files to isolated home directory (default: ~/.codex-plus-mcp)
 * 3. Interactive multi-account data entry (account ID, label, optional default model)
 * 4. Per-account official ChatGPT Plus OAuth authorization (`CODEX_HOME` isolated)
 * 5. Optional DeepSeek API key local configuration + live balance check
 * 6. Optional Antigravity 2.0 native Plugin registration + generic MCP JSON output
 * 7. Automatic MCP protocol self-test
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const SERVER_VERSION = "3.2.0";

const DEFAULT_MODEL_TIERS = {
  economy: { model: "gpt-6-luna", defaultReasoningEffort: "medium" },
  balanced: { model: "gpt-6.2-sol", defaultReasoningEffort: "high" },
  flagship: { model: "gpt-6.2-astra", defaultReasoningEffort: "high" },
  vision: { model: "gpt-6.1-terra", defaultReasoningEffort: "high" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    loginAccount: null,
    targetDir: process.env.CODEX_BRIDGE_HOME || path.join(os.homedir(), ".codex-plus-mcp"),
    nonInteractive: false,
    skipAuth: false,
    skipAntigravity: false,
    skipTest: false,
    accountsJson: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--login" && argv[i + 1]) {
      opts.loginAccount = argv[++i];
    } else if (a === "--target" && argv[i + 1]) {
      opts.targetDir = path.resolve(argv[++i]);
    } else if (a === "--non-interactive") {
      opts.nonInteractive = true;
    } else if (a === "--skip-auth") {
      opts.skipAuth = true;
    } else if (a === "--skip-antigravity") {
      opts.skipAntigravity = true;
    } else if (a === "--skip-test") {
      opts.skipTest = true;
    } else if (a === "--accounts" && argv[i + 1]) {
      opts.accountsJson = argv[++i];
    } else if (a === "-h" || a === "--help") {
      console.log(`Codex Plus MCP Setup Wizard v${SERVER_VERSION}

Usage:
  node scripts/setup.mjs [options]

Options:
  --login <accountId>     Run OAuth login for a single account ID
  --target <dir>          Install/data directory (default: ~/.codex-plus-mcp)
  --non-interactive       Run without interactive prompts
  --accounts '<json>'     JSON array of {id, label, defaultModel} for non-interactive setup
  --skip-auth             Skip browser OAuth authorization step
  --skip-antigravity      Skip Antigravity 2.0 Plugin installation
  --skip-test             Skip post-install MCP self-test
`);
      process.exit(0);
    }
  }
  return opts;
}

function validateAccountId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{1,32}$/.test(id);
}

function maskSecret(key) {
  if (!key || key.length < 10) return "****";
  return `${key.slice(0, 5)}****${key.slice(-4)}`;
}

function writeUtf8NoBom(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function ensureAccountFiles(targetDir, accountId) {
  const accDir = path.join(targetDir, "accounts", accountId);
  fs.mkdirSync(accDir, { recursive: true });
  const cfgPath = path.join(accDir, "config.toml");
  if (!fs.existsSync(cfgPath)) {
    writeUtf8NoBom(
      cfgPath,
      '# Isolated Codex CLI config\ncli_auth_credentials_store = "file"\n'
    );
  } else {
    const clean = fs.readFileSync(cfgPath, "utf8").replace(/^\uFEFF/, "");
    writeUtf8NoBom(cfgPath, clean);
  }
  return accDir;
}

function isAccountLoggedIn(targetDir, accountId) {
  const authPath = path.join(targetDir, "accounts", accountId, "auth.json");
  try {
    return fs.existsSync(authPath) && fs.statSync(authPath).size > 10;
  } catch {
    return false;
  }
}

function loadOrCreateRegistry(targetDir) {
  const regPath = path.join(targetDir, "accounts.json");
  if (fs.existsSync(regPath)) {
    const raw = fs.readFileSync(regPath, "utf8").replace(/^\uFEFF/, "");
    const reg = JSON.parse(raw);
    reg.version = 4;
    reg.accounts = reg.accounts || {};
    reg.modelTiers = reg.modelTiers || structuredClone(DEFAULT_MODEL_TIERS);
    reg.deepseek = reg.deepseek || {
      callCount: 0,
      totalTokens: 0,
      lastUsedAt: null,
      lastUsage: null,
      lastBalance: null,
    };
    return reg;
  }
  return {
    version: 4,
    modelTiers: structuredClone(DEFAULT_MODEL_TIERS),
    deepseek: {
      callCount: 0,
      totalTokens: 0,
      lastUsedAt: null,
      lastUsage: null,
      lastBalance: null,
    },
    accounts: {},
  };
}

function saveRegistry(targetDir, reg) {
  const regPath = path.join(targetDir, "accounts.json");
  writeUtf8NoBom(regPath, JSON.stringify(reg, null, 2) + "\n");
}

function createAccountMeta(label, defaultModel = "") {
  return {
    label,
    defaultModel,
    lastUsedAt: null,
    callCount: 0,
    totalTokens: 0,
    lastUsage: null,
    lastQuota: null,
    lastSessionId: null,
    recentSessions: [],
    cooldownUntil: null,
    lastError: null,
  };
}

function resolveCodexBinary() {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    const npmCodexJs = path.join(
      appData,
      "npm",
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js"
    );
    if (fs.existsSync(npmCodexJs)) {
      return { cmd: process.execPath, prefix: [npmCodexJs], found: true };
    }
    const probe = spawnSync("cmd.exe", ["/d", "/s", "/c", "codex --version"], { encoding: "utf8" });
    if (probe.status === 0) {
      return { cmd: "cmd.exe", prefix: ["/d", "/s", "/c", "codex"], found: true };
    }
    return { cmd: null, prefix: [], found: false };
  }
  const probe = spawnSync("codex", ["--version"], { encoding: "utf8" });
  return probe.status === 0
    ? { cmd: "codex", prefix: [], found: true }
    : { cmd: null, prefix: [], found: false };
}

function runCodexLogin(targetDir, accountId) {
  const codexBin = resolveCodexBinary();
  if (!codexBin.found) {
    console.error("\n[错误] 未检测到 OpenAI Codex CLI，请先安装：npm install -g @openai/codex");
    return false;
  }
  const accDir = ensureAccountFiles(targetDir, accountId);
  const env = { ...process.env, CODEX_HOME: accDir };
  // Ensure Plus subscription OAuth is used instead of API key
  delete env.OPENAI_API_KEY;

  console.log(`\n>>> 正在为账号 [${accountId}] 启动官方 ChatGPT Plus OAuth 登录...`);
  console.log(`    隔离目录 (CODEX_HOME): ${accDir}`);
  console.log("    提示：登录第 2 个及以上账号时，请先在浏览器切换账号，或将授权链接复制到无痕窗口打开。\n");

  const res = spawnSync(codexBin.cmd, [...codexBin.prefix, "login"], {
    env,
    stdio: "inherit",
  });

  if (isAccountLoggedIn(targetDir, accountId)) {
    console.log(`\n[成功] 账号 [${accountId}] 授权凭据已安全保存至隔离目录。\n`);
    return true;
  }
  console.log(
    `\n[未完成] 未检测到 ${path.join(accDir, "auth.json")}（退出码：${res.status ?? "unknown"}）。\n`
  );
  return false;
}

function printAccountTable(targetDir, reg) {
  console.log("\n=== 当前 ChatGPT Plus 隔离账号池 ===");
  const keys = Object.keys(reg.accounts || {});
  if (keys.length === 0) {
    console.log("  （暂无账号）");
    return;
  }
  for (const id of keys) {
    const meta = reg.accounts[id];
    const logged = isAccountLoggedIn(targetDir, id);
    const status = logged ? "[已授权]" : "[未登录]";
    const modelStr = meta.defaultModel ? ` | 默认模型: ${meta.defaultModel}` : "";
    console.log(`  - ${id.padEnd(12)} ${status}  备注: ${meta.label}${modelStr}`);
  }
  console.log("");
}

async function verifyDeepSeekKey(apiKey, baseUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const resp = await fetch(`${baseUrl.replace(/\/+$/, "")}/user/balance`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!resp.ok) return { ok: false, status: resp.status };
    const data = await resp.json();
    const brief = Array.isArray(data.balance_infos)
      ? data.balance_infos.map((b) => `${b.total_balance} ${b.currency}`).join(" / ")
      : "未知";
    return { ok: true, available: Boolean(data.is_available), brief };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function deployRuntimeFiles(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(path.join(targetDir, "accounts"), { recursive: true });
  fs.mkdirSync(path.join(targetDir, "scripts"), { recursive: true });

  const serverSrc = path.join(REPO_ROOT, "src", "server.mjs");
  const serverDst = path.join(targetDir, "server.mjs");
  if (fs.existsSync(serverSrc) && path.resolve(serverSrc) !== path.resolve(serverDst)) {
    fs.copyFileSync(serverSrc, serverDst);
  }

  const setupDst = path.join(targetDir, "scripts", "setup.mjs");
  if (path.resolve(__filename) !== path.resolve(setupDst)) {
    fs.copyFileSync(__filename, setupDst);
  }

  const testSrc = path.join(REPO_ROOT, "test", "test-mcp.mjs");
  const testDst = path.join(targetDir, "test-mcp.mjs");
  if (fs.existsSync(testSrc) && path.resolve(testSrc) !== path.resolve(testDst)) {
    fs.copyFileSync(testSrc, testDst);
  }

  return serverDst;
}

function installAntigravityPlugin(targetDir, serverPath) {
  const geminiConfigDir = path.join(os.homedir(), ".gemini", "config");
  const pluginDir = path.join(geminiConfigDir, "plugins", "codex-plus");
  const skillDstDir = path.join(pluginDir, "skills", "codex-plus-orchestrator");
  const rulesDstDir = path.join(pluginDir, "rules");

  fs.mkdirSync(skillDstDir, { recursive: true });
  fs.mkdirSync(rulesDstDir, { recursive: true });

  const pluginJson = {
    name: "codex-plus",
    displayName: "Codex Plus (Multi-Account + DeepSeek)",
    description:
      "Orchestrate multiple isolated ChatGPT Plus (OpenAI Codex CLI) accounts with quota tracking, model tier routing, image inputs, Git worktree isolation, and optional DeepSeek research.",
    version: SERVER_VERSION,
    suggestedPrompts: [
      "查看我所有 ChatGPT Plus 账号与 DeepSeek 的实时剩余额度",
      "先全网调研可借鉴方案存入缓存区，再与 GPT 背靠背出方案并画架构图",
      "选推荐 Plus 账号对当前项目做两阶段分级代码审查",
    ],
  };
  writeUtf8NoBom(path.join(pluginDir, "plugin.json"), JSON.stringify(pluginJson, null, 2) + "\n");

  const mcpConfig = {
    mcpServers: {
      bridge: {
        command: process.execPath,
        args: [serverPath],
        env: {
          CODEX_BRIDGE_HOME: targetDir,
        },
      },
    },
  };
  writeUtf8NoBom(path.join(pluginDir, "mcp_config.json"), JSON.stringify(mcpConfig, null, 2) + "\n");

  const skillTemplate = path.join(REPO_ROOT, "templates", "antigravity", "SKILL.md");
  const ruleTemplate = path.join(REPO_ROOT, "templates", "antigravity", "AGENTS.md");
  if (fs.existsSync(skillTemplate)) {
    fs.copyFileSync(skillTemplate, path.join(skillDstDir, "SKILL.md"));
  }
  if (fs.existsSync(ruleTemplate)) {
    fs.copyFileSync(ruleTemplate, path.join(rulesDstDir, "AGENTS.md"));
  }

  return pluginDir;
}

function printGenericMcpSnippet(targetDir, serverPath) {
  const snippet = {
    mcpServers: {
      "codex-plus": {
        command: process.execPath,
        args: [serverPath],
        env: {
          CODEX_BRIDGE_HOME: targetDir,
        },
      },
    },
  };
  console.log("\n=== 通用 MCP 客户端配置片段（Claude Code / Cursor / Windsurf 等） ===");
  console.log(JSON.stringify(snippet, null, 2));
}

// ---------------------------------------------------------------------------
// Main Flow
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Fast path: single-account login helper (`setup.mjs --login <id>`)
  if (opts.loginAccount) {
    if (!validateAccountId(opts.loginAccount)) {
      console.error(`[错误] 无效的账号 ID: "${opts.loginAccount}"（仅允许字母、数字、下划线和连字符）`);
      process.exit(1);
    }
    const reg = loadOrCreateRegistry(opts.targetDir);
    if (!reg.accounts[opts.loginAccount]) {
      reg.accounts[opts.loginAccount] = createAccountMeta(`Plus Account (${opts.loginAccount})`);
      saveRegistry(opts.targetDir, reg);
    }
    const ok = runCodexLogin(opts.targetDir, opts.loginAccount);
    printAccountTable(opts.targetDir, reg);
    process.exit(ok ? 0 : 1);
  }

  console.log(`\n=============================================================`);
  console.log(`  Codex Plus MCP v${SERVER_VERSION} — 安装与账号授权向导`);
  console.log(`=============================================================\n`);

  // Step 1: Environment check
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 20) {
    console.error(`[错误] 需要 Node.js >= 20，当前版本为 ${process.version}`);
    process.exit(1);
  }
  const codexCheck = resolveCodexBinary();
  console.log(`[环境检查] Node.js ${process.version} (OK)`);
  console.log(
    codexCheck.found
      ? `[环境检查] OpenAI Codex CLI 已检测到 (OK)`
      : `[警告] 未检测到 @openai/codex CLI，请先运行: npm install -g @openai/codex`
  );

  const rl = opts.nonInteractive
    ? null
    : createInterface({ input: process.stdin, output: process.stdout });

  const ask = async (question, defaultVal = "") => {
    if (!rl) return defaultVal;
    const suffix = defaultVal ? ` [默认: ${defaultVal}]` : "";
    const ans = (await rl.question(`${question}${suffix}: `)).trim();
    return ans || defaultVal;
  };

  try {
    // Step 2: Confirm installation/data directory
    let targetDir = opts.targetDir;
    if (!opts.nonInteractive) {
      const inputDir = await ask("\n[步骤 1/5] 运行与账号数据存放目录（建议纯英文路径，与代码仓库隔离）", targetDir);
      targetDir = path.resolve(inputDir);
    }
    const serverPath = deployRuntimeFiles(targetDir);
    console.log(`  -> 已部署运行文件至: ${targetDir}`);

    // Step 3: Interactive Account Data Entry
    const reg = loadOrCreateRegistry(targetDir);
    const existingIds = Object.keys(reg.accounts);

    if (opts.nonInteractive) {
      if (opts.accountsJson) {
        const list = JSON.parse(opts.accountsJson);
        for (const item of list) {
          if (!validateAccountId(item.id)) {
            throw new Error(`Invalid account id: ${item.id}`);
          }
          if (!reg.accounts[item.id]) {
            reg.accounts[item.id] = createAccountMeta(item.label || item.id, item.defaultModel || "");
          } else {
            if (item.label) reg.accounts[item.id].label = item.label;
            if (item.defaultModel !== undefined) reg.accounts[item.id].defaultModel = item.defaultModel;
          }
          ensureAccountFiles(targetDir, item.id);
        }
      } else if (existingIds.length === 0) {
        reg.accounts["plus-1"] = createAccountMeta("Personal");
        ensureAccountFiles(targetDir, "plus-1");
      }
      saveRegistry(targetDir, reg);
    } else {
      console.log("\n[步骤 2/5] ChatGPT Plus 账号数据录入");
      if (existingIds.length > 0) {
        printAccountTable(targetDir, reg);
      }
      const defaultCount = existingIds.length > 0 ? "0" : "1";
      const countPrompt =
        existingIds.length > 0
          ? "需要新增几个 ChatGPT Plus 账号槽位？（输入 0 保持现有账号不变）"
          : "需要配置几个 ChatGPT Plus 账号？（支持 1~10 个，例如输入 3）";
      const countStr = await ask(countPrompt, defaultCount);
      const addCount = Math.min(Math.max(parseInt(countStr, 10) || 0, 0), 10);

      for (let i = 1; i <= addCount; i++) {
        let idx = Object.keys(reg.accounts).length + 1;
        let suggestedId = `plus-${idx}`;
        while (reg.accounts[suggestedId]) {
          idx++;
          suggestedId = `plus-${idx}`;
        }

        console.log(`\n  --- 录入第 ${i}/${addCount} 个账号 ---`);
        let accId = "";
        while (!validateAccountId(accId)) {
          accId = await ask("  账号 ID（仅限字母/数字/_/-）", suggestedId);
          if (!validateAccountId(accId)) {
            console.log("  [提示] 账号 ID 格式不合法，请重新输入。");
          }
        }
        const defaultLabel = reg.accounts[accId]?.label || `Plus Account ${idx}`;
        const label = await ask("  备注标签（如：主力号 / personal / work，方便口头点名）", defaultLabel);
        const defaultModel = await ask("  默认模型（直接回车跳过，自动按任务难度分级路由）", "");

        if (!reg.accounts[accId]) {
          reg.accounts[accId] = createAccountMeta(label, defaultModel);
        } else {
          reg.accounts[accId].label = label;
          if (defaultModel) reg.accounts[accId].defaultModel = defaultModel;
        }
        ensureAccountFiles(targetDir, accId);
        console.log(`  -> 已录入账号: ${accId} (${label})`);
      }

      if (Object.keys(reg.accounts).length === 0) {
        reg.accounts["plus-1"] = createAccountMeta("Plus Account 1");
        ensureAccountFiles(targetDir, "plus-1");
      }
      saveRegistry(targetDir, reg);
    }

    // Step 4: Per-Account Official OAuth Authorization
    if (!opts.skipAuth && !opts.nonInteractive) {
      console.log("\n[步骤 3/5] 官方 ChatGPT Plus OAuth 授权");
      const allIds = Object.keys(reg.accounts);
      const pendingIds = allIds.filter((id) => !isAccountLoggedIn(targetDir, id));
      if (pendingIds.length === 0) {
        console.log("  所有已录入账号均已完成授权！如需重新登录，可运行：");
        console.log(`  node "${path.join(targetDir, "scripts", "setup.mjs")}" --login <accountId>`);
      } else {
        const doAuth = (
          await ask(
            `检测到 ${pendingIds.length} 个未登录账号 (${pendingIds.join(", ")})，是否现在逐个打开浏览器授权？(Y/n)`,
            "Y"
          )
        ).toLowerCase();

        if (doAuth !== "n" && doAuth !== "no") {
          for (const id of pendingIds) {
            const label = reg.accounts[id]?.label || id;
            const confirmOne = (
              await ask(`  立即授权 [${id}]（${label}）？(Y/n/skip)`, "Y")
            ).toLowerCase();
            if (confirmOne === "n" || confirmOne === "no" || confirmOne === "skip") {
              console.log(`  -> 已跳过 [${id}]，稍后可随时运行 --login ${id} 补登。`);
              continue;
            }
            let ok = runCodexLogin(targetDir, id);
            while (!ok) {
              const retry = (await ask(`  [${id}] 授权未完成，是否重试？(y/N)`, "N")).toLowerCase();
              if (retry !== "y" && retry !== "yes") break;
              ok = runCodexLogin(targetDir, id);
            }
          }
        }
      }
    }

    // Step 5: Optional DeepSeek API Key Setup
    if (!opts.nonInteractive) {
      console.log("\n[步骤 4/5] 可选配置 DeepSeek API（用于低成本全网调研与文档预读，不配置不影响 GPT）");
      const dsPath = path.join(targetDir, "deepseek.json");
      const alreadyConfigured = fs.existsSync(dsPath) || Boolean(process.env.DEEPSEEK_API_KEY);
      if (alreadyConfigured) {
        console.log(`  已检测到本地 DeepSeek 配置（${fs.existsSync(dsPath) ? dsPath : "环境变量"}）。`);
      }
      const cfgDs = (
        await ask(alreadyConfigured ? "是否更新 DeepSeek API Key？(y/N)" : "是否现在配置 DeepSeek API Key？(y/N)", "N")
      ).toLowerCase();

      if (cfgDs === "y" || cfgDs === "yes") {
        const apiKey = await ask("  请输入 DeepSeek API Key（sk-...）", "");
        if (apiKey) {
          const baseUrl = await ask("  DeepSeek API Base URL", "https://api.deepseek.com");
          writeUtf8NoBom(dsPath, JSON.stringify({ apiKey, baseUrl }, null, 2) + "\n");
          if (process.platform !== "win32") {
            try {
              fs.chmodSync(dsPath, 0o600);
            } catch {}
          }
          console.log(`  -> 已安全写入本地文件 ${dsPath}（密钥：${maskSecret(apiKey)}，绝不会进入代码仓库）`);
          console.log("  -> 正在校验 DeepSeek 余额接口...");
          const check = await verifyDeepSeekKey(apiKey, baseUrl);
          if (check.ok) {
            console.log(`  -> [验证成功] 账户可用: ${check.available} | 当前余额: ${check.brief}`);
          } else {
            console.log(`  -> [提示] 余额探测未通过（${check.status || check.error}），密钥已保存，请确认网络或密钥有效性。`);
          }
        }
      }
    }

    // Step 6: Client Integration (Antigravity 2.0 Plugin + Generic MCP Snippet)
    let installAgy = !opts.skipAntigravity;
    if (!opts.nonInteractive && !opts.skipAntigravity) {
      console.log("\n[步骤 5/5] MCP 客户端接入");
      const ans = (
        await ask("是否自动安装为 Google Antigravity 2.0 原生 Plugin（含 MCP + Skill + Rule）？(Y/n)", "Y")
      ).toLowerCase();
      installAgy = ans !== "n" && ans !== "no";
    }

    if (installAgy) {
      const pluginDir = installAntigravityPlugin(targetDir, serverPath);
      console.log(`  -> 已安装 Antigravity 2.0 Plugin: ${pluginDir}`);
    }
    printGenericMcpSnippet(targetDir, serverPath);

    // Step 7: Self-Test
    if (!opts.skipTest) {
      const testFile = path.join(targetDir, "test-mcp.mjs");
      if (fs.existsSync(testFile)) {
        console.log("\n=== 运行 MCP 协议与功能自检 ===");
        const tRes = spawnSync(process.execPath, [testFile], {
          env: { ...process.env, CODEX_BRIDGE_HOME: targetDir },
          stdio: "inherit",
        });
        if (tRes.status !== 0) {
          console.error("\n[警告] 自检未完全通过，请查看上方日志。");
          process.exitCode = 1;
        }
      }
    }

    printAccountTable(targetDir, loadOrCreateRegistry(targetDir));
    console.log("安装向导完成！重启你的 MCP 客户端（如 Antigravity / Claude Code / Cursor）即可使用。");
  } finally {
    if (rl) rl.close();
  }
}

main().catch((err) => {
  console.error("[setup error]", err);
  process.exit(1);
});
