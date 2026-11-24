#!/usr/bin/env node
/**
 * Codex Plus Multi-Account MCP Server v3.3.0 (Zero-Dependency Stdio JSON-RPC 2.0)
 *
 * Open-source standalone edition:
 * - Isolated multi-account ChatGPT Plus pool via OpenAI Codex CLI (`CODEX_HOME` +
 *   `cli_auth_credentials_store = "file"`), stored outside the repo by default
 *   (`~/.codex-plus-mcp`, configurable via `CODEX_BRIDGE_HOME`).
 * - Atomic, concurrency-safe registry mutations (`mutateRegistry`) with serial queue,
 *   fresh disk re-read, random temp file, and Windows EBUSY/EPERM rename retry.
 * - Cross-platform full process-tree cleanup (`taskkill /pid <pid> /t /f` on Windows).
 * - Supports image attachments (`-i ... -- -` clap-safe), native GPT image generation
 *   & editing (`codex_generate_image` via `--enable image_generation`, 0 extra API fees),
 *   isolated Git `--worktree` writes, tiered GPT model routing (`economy` / `balanced` /
 *   `flagship` / `vision`) with automatic CLI-default fallback, accurate official 429
 *   cooldowns, 5-min TTL quota caching, and `recommendedAccount` ranking.
 * - Optional DeepSeek extension (`deepseek_ask` / `deepseek_search`) with token usage
 *   and live `/user/balance` reporting (configured via DEEPSEEK_API_KEY or deepseek.json).
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const SERVER_VERSION = "3.3.0";
// Default runtime data home is outside the repository to prevent accidental secret commits
const BASE_DIR = process.env.CODEX_BRIDGE_HOME || path.join(os.homedir(), ".codex-plus-mcp");
const ACCOUNTS_DIR = path.join(BASE_DIR, "accounts");
const REGISTRY_PATH = path.join(BASE_DIR, "accounts.json");
const DEEPSEEK_CONFIG_PATH = path.join(BASE_DIR, "deepseek.json");

const DEFAULT_TIMEOUT_SEC = 300;
const MAX_TIMEOUT_SEC = 900;
const FALLBACK_COOLDOWN_MINUTES = 30;
const MAX_RECENT_SESSIONS = 15;
const QUOTA_QUERY_TIMEOUT_MS = 5000;
const QUOTA_CACHE_TTL_MS = 5 * 60 * 1000;

const DEFAULT_MODEL_TIERS = {
  economy: { model: "gpt-6-luna", defaultReasoningEffort: "medium" },
  balanced: { model: "gpt-6.2-sol", defaultReasoningEffort: "high" },
  flagship: { model: "gpt-6.2-astra", defaultReasoningEffort: "high" },
  vision: { model: "gpt-6.1-terra", defaultReasoningEffort: "high" },
};

const DEEPSEEK_MODELS = {
  flash: "deepseek-flash",
  pro: "deepseek-v4-pro",
};

// ---------------------------------------------------------------------------
// Process Tree Cleanup (Windows-safe)
// ---------------------------------------------------------------------------

function killProcessTree(child) {
  if (!child) return;
  const pid = child.pid;
  if (process.platform === "win32" && pid) {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => {
        try {
          child.kill("SIGKILL");
        } catch {}
      });
      return;
    } catch {
      // Fall through to child.kill
    }
  }
  try {
    child.kill("SIGTERM");
    setTimeout(() => {
      try {
        if (!child.killed) child.kill("SIGKILL");
      } catch {}
    }, 2000);
  } catch {}
}

// ---------------------------------------------------------------------------
// Registry & Atomic Concurrency-Safe Mutations
// ---------------------------------------------------------------------------

function ensureAccountDir(accountName) {
  const dir = path.join(ACCOUNTS_DIR, accountName);
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, "config.toml");
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(
      configPath,
      '# Auto-generated isolated Codex config\ncli_auth_credentials_store = "file"\n',
      "utf8"
    );
  }
  return dir;
}

function createEmptyAccountMeta(label) {
  return {
    label,
    defaultModel: "",
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

function createEmptyDeepSeekStats() {
  return {
    callCount: 0,
    totalTokens: 0,
    lastUsedAt: null,
    lastUsage: null,
    lastBalance: null,
  };
}

function normalizeRegistry(reg) {
  const normalized = reg && typeof reg === "object" ? reg : { version: 4, accounts: {} };
  if (!normalized.accounts || typeof normalized.accounts !== "object") {
    normalized.accounts = {};
  }
  if (!normalized.modelTiers || typeof normalized.modelTiers !== "object") {
    normalized.modelTiers = structuredClone(DEFAULT_MODEL_TIERS);
  } else {
    for (const [k, defVal] of Object.entries(DEFAULT_MODEL_TIERS)) {
      if (!normalized.modelTiers[k]) {
        normalized.modelTiers[k] = { ...defVal };
      }
    }
  }
  if (!normalized.deepseek || typeof normalized.deepseek !== "object") {
    normalized.deepseek = createEmptyDeepSeekStats();
  }

  for (const meta of Object.values(normalized.accounts)) {
    if (!Array.isArray(meta.recentSessions)) {
      meta.recentSessions = [];
      if (meta.lastSessionId) {
        meta.recentSessions.push({
          sessionId: meta.lastSessionId,
          topic: "历史会话",
          workingDir: "",
          createdAt: meta.lastUsedAt || new Date().toISOString(),
          lastUsedAt: meta.lastUsedAt || new Date().toISOString(),
          turnCount: 1,
          totalTokens: 0,
        });
      }
    }
    if (typeof meta.totalTokens !== "number") meta.totalTokens = 0;
    if (meta.lastUsage === undefined) meta.lastUsage = null;
    if (meta.lastQuota === undefined) meta.lastQuota = null;
  }
  normalized.version = 4;
  return normalized;
}

function loadRegistrySync() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    const initial = normalizeRegistry({
      version: 4,
      modelTiers: structuredClone(DEFAULT_MODEL_TIERS),
      deepseek: createEmptyDeepSeekStats(),
      accounts: {
        "plus-1": createEmptyAccountMeta("Plus Account 1"),
      },
    });
    writeRegistryAtomicSync(initial);
    for (const name of Object.keys(initial.accounts)) {
      ensureAccountDir(name);
    }
    return initial;
  }
  const raw = fs.readFileSync(REGISTRY_PATH, "utf8").replace(/^\uFEFF/, "");
  return normalizeRegistry(JSON.parse(raw));
}

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

function writeRegistryAtomicSync(reg) {
  reg.version = 4;
  const dir = path.dirname(REGISTRY_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `accounts.json.${crypto.randomUUID()}.tmp`);
  const payload = JSON.stringify(reg, null, 2) + "\n";

  try {
    fs.writeFileSync(tmpPath, payload, "utf8");
    const retryDelays = [25, 50, 100, 150, 250, 400];
    let lastErr = null;
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        fs.renameSync(tmpPath, REGISTRY_PATH);
        return;
      } catch (err) {
        lastErr = err;
        const code = err?.code;
        if ((code === "EBUSY" || code === "EPERM" || code === "EACCES") && attempt < retryDelays.length) {
          sleepSync(retryDelays[attempt]);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
  }
}

let registryMutationQueue = Promise.resolve();

function mutateRegistry(mutatorFn) {
  const task = registryMutationQueue.then(async () => {
    const reg = loadRegistrySync();
    const res = await mutatorFn(reg);
    writeRegistryAtomicSync(reg);
    return res;
  });
  registryMutationQueue = task.catch(() => {});
  return task;
}

function validateAccountName(name) {
  return typeof name === "string" && /^[a-zA-Z0-9_-]{1,32}$/.test(name);
}

function resolveAccountKey(reg, input) {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim();
  if (reg.accounts[trimmed]) return trimmed;
  const lower = trimmed.toLowerCase();
  for (const [key, meta] of Object.entries(reg.accounts)) {
    if (key.toLowerCase() === lower) return key;
    if (meta?.label && meta.label.trim().toLowerCase() === lower) return key;
  }
  return null;
}

function recordSessionUsage(meta, { sessionId, topic, workingDir, isResume, turnTokens = 0 }) {
  if (!sessionId) return;
  if (!Array.isArray(meta.recentSessions)) meta.recentSessions = [];
  const nowIso = new Date().toISOString();
  const idx = meta.recentSessions.findIndex((s) => s.sessionId === sessionId);

  if (idx >= 0) {
    const existing = meta.recentSessions[idx];
    existing.lastUsedAt = nowIso;
    existing.turnCount = (existing.turnCount || 1) + 1;
    existing.totalTokens = (existing.totalTokens || 0) + (turnTokens || 0);
    if (topic && topic.trim()) existing.topic = topic.trim().slice(0, 80);
    if (workingDir && !existing.workingDir) existing.workingDir = workingDir;
    meta.recentSessions.splice(idx, 1);
    meta.recentSessions.unshift(existing);
  } else {
    meta.recentSessions.unshift({
      sessionId,
      topic: (topic && topic.trim() ? topic.trim() : isResume ? "续聊任务" : "未命名任务").slice(0, 80),
      workingDir: workingDir || "",
      createdAt: nowIso,
      lastUsedAt: nowIso,
      turnCount: 1,
      totalTokens: turnTokens || 0,
    });
  }

  if (meta.recentSessions.length > MAX_RECENT_SESSIONS) {
    meta.recentSessions = meta.recentSessions.slice(0, MAX_RECENT_SESSIONS);
  }
  meta.lastSessionId = sessionId;
}

function getAuthInfo(accountName) {
  const dir = ensureAccountDir(accountName);
  const authPath = path.join(dir, "auth.json");
  if (!fs.existsSync(authPath)) {
    return { loggedIn: false, authFile: authPath, updatedAt: null };
  }
  try {
    const stat = fs.statSync(authPath);
    return {
      loggedIn: stat.size > 10,
      authFile: authPath,
      updatedAt: stat.mtime.toISOString(),
    };
  } catch {
    return { loggedIn: false, authFile: authPath, updatedAt: null };
  }
}

function isCoolingDown(meta) {
  if (!meta?.cooldownUntil) return false;
  return Date.now() < Date.parse(meta.cooldownUntil);
}

function isGitRepository(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return false;
  try {
    let current = path.resolve(dirPath);
    while (true) {
      if (fs.existsSync(path.join(current, ".git"))) return true;
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  } catch {
    return false;
  }
}

function validateImages(images) {
  if (images === undefined || images === null) return { ok: true, paths: [] };
  if (!Array.isArray(images)) {
    return { ok: false, error: "参数 images 必须是本地图片路径数组（string[]）。" };
  }
  const resolved = [];
  for (const item of images) {
    if (typeof item !== "string" || !item.trim()) {
      return { ok: false, error: "images 中包含空路径或非字符串项。" };
    }
    const abs = path.resolve(item.trim());
    if (!fs.existsSync(abs)) {
      return { ok: false, error: `图片文件不存在：${abs}` };
    }
    try {
      if (!fs.statSync(abs).isFile()) {
        return { ok: false, error: `路径不是文件：${abs}` };
      }
    } catch {
      return { ok: false, error: `无法访问图片文件：${abs}` };
    }
    resolved.push(abs);
  }
  return { ok: true, paths: resolved };
}

function resolveTierConfig(reg, tier, explicitModel, explicitEffort, accountDefaultModel) {
  const validTiers = ["economy", "balanced", "flagship", "vision"];
  const normalizedTier =
    typeof tier === "string" && validTiers.includes(tier.trim().toLowerCase())
      ? tier.trim().toLowerCase()
      : null;

  const tierMap = (reg && reg.modelTiers) || DEFAULT_MODEL_TIERS;
  const tierEntry = normalizedTier ? tierMap[normalizedTier] || DEFAULT_MODEL_TIERS[normalizedTier] : null;

  const validEfforts = new Set(["minimal", "low", "medium", "high", "xhigh"]);
  const explicitEffortClean = validEfforts.has(String(explicitEffort || "").toLowerCase())
    ? String(explicitEffort).toLowerCase()
    : "";

  const chosenModel =
    (typeof explicitModel === "string" && explicitModel.trim()) ||
    (tierEntry?.model || "") ||
    (typeof accountDefaultModel === "string" && accountDefaultModel.trim()) ||
    "";

  const chosenEffort = explicitEffortClean || tierEntry?.defaultReasoningEffort || "";

  return {
    tier: normalizedTier,
    model: chosenModel,
    reasoningEffort: chosenEffort,
    cameFromTier: Boolean(!explicitModel && tierEntry?.model),
  };
}

function getLoginInstruction(accountId) {
  const setupScript = path.join(BASE_DIR, "scripts", "setup.mjs");
  if (fs.existsSync(setupScript)) {
    return `node "${setupScript}" --login ${accountId}`;
  }
  return `CODEX_HOME="${path.join(ACCOUNTS_DIR, accountId)}" codex login`;
}

// ---------------------------------------------------------------------------
// Codex CLI & App-Server Execution Helpers
// ---------------------------------------------------------------------------

function resolveCodexLauncher() {
  if (process.env.CODEX_JS_PATH && fs.existsSync(process.env.CODEX_JS_PATH)) {
    return {
      command: process.execPath,
      prefixArgs: [process.env.CODEX_JS_PATH],
      useShell: false,
    };
  }

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
      return {
        command: process.execPath,
        prefixArgs: [npmCodexJs],
        useShell: false,
      };
    }
    return {
      command: "cmd.exe",
      prefixArgs: ["/d", "/s", "/c", "codex"],
      useShell: false,
    };
  }

  return {
    command: "codex",
    prefixArgs: [],
    useShell: false,
  };
}

function runCodexProcess({ accountDir, args, stdinText = null, cwd = null, timeoutSec = DEFAULT_TIMEOUT_SEC }) {
  return new Promise((resolve) => {
    const launcher = resolveCodexLauncher();
    const env = { ...process.env, CODEX_HOME: accountDir };
    delete env.OPENAI_API_KEY;

    const spawnOpts = {
      env,
      shell: launcher.useShell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    };
    if (cwd && fs.existsSync(cwd)) {
      spawnOpts.cwd = cwd;
    }

    const startedAt = Date.now();
    const child = spawn(launcher.command, [...launcher.prefixArgs, ...args], spawnOpts);

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const clampedTimeout = Math.min(Math.max(Number(timeoutSec) || DEFAULT_TIMEOUT_SEC, 10), MAX_TIMEOUT_SEC);
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, clampedTimeout * 1000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        code: -1,
        stdout,
        stderr: `${stderr}\nSpawn error: ${err.message}`.trim(),
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });

    if (stdinText !== null && stdinText !== undefined) {
      child.stdin.write(stdinText, "utf8");
    }
    child.stdin.end();
  });
}

function fetchLiveRateLimits(accountDir, timeoutMs = QUOTA_QUERY_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const launcher = resolveCodexLauncher();
    const env = { ...process.env, CODEX_HOME: accountDir };
    delete env.OPENAI_API_KEY;

    let finished = false;
    let child;
    let rl;
    let timer;

    const done = (val) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      try {
        if (rl) rl.close();
      } catch {}
      killProcessTree(child);
      resolve(val);
    };

    try {
      child = spawn(launcher.command, [...launcher.prefixArgs, "app-server", "--stdio"], {
        env,
        shell: launcher.useShell,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      return done(null);
    }

    timer = setTimeout(() => done(null), timeoutMs);

    child.on("error", () => done(null));
    child.on("exit", () => done(null));

    rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("{")) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }

      if (msg.id === 1) {
        if (msg.error) return done(null);
        try {
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
          child.stdin.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "account/rateLimits/read",
              params: { excludeResetCreditDetails: true },
            }) + "\n"
          );
        } catch {
          return done(null);
        }
      } else if (msg.id === 2) {
        if (msg.error || !msg.result?.rateLimits) return done(null);
        const res = msg.result;
        const rlSnap = res.rateLimits;
        const formatWin = (w, defaultMins) => {
          if (!w || typeof w.usedPercent !== "number") return null;
          return {
            usedPercent: w.usedPercent,
            remainingPercent: Math.max(0, 100 - w.usedPercent),
            windowDurationMins: w.windowDurationMins ?? defaultMins,
            resetsAt: typeof w.resetsAt === "number" ? new Date(w.resetsAt * 1000).toISOString() : null,
          };
        };
        done({
          fetchedAt: new Date().toISOString(),
          planType: rlSnap.planType || null,
          ordinaryUsageAllowed: res.ordinaryUsageAllowed ?? null,
          primary: formatWin(rlSnap.primary, 300),
          secondary: formatWin(rlSnap.secondary, 10080),
        });
      }
    });

    try {
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "codex-plus-bridge", version: SERVER_VERSION },
          },
        }) + "\n"
      );
    } catch {
      done(null);
    }
  });
}

function shouldRefreshQuota(prevQuota, turnTokens) {
  if (!prevQuota || !prevQuota.fetchedAt) return true;
  if ((turnTokens || 0) >= 10000) return true;
  const ageMs = Date.now() - Date.parse(prevQuota.fetchedAt);
  if (!Number.isFinite(ageMs) || ageMs > QUOTA_CACHE_TTL_MS) return true;
  if ((prevQuota.primary?.usedPercent ?? 0) >= 50) return true;
  if ((prevQuota.secondary?.usedPercent ?? 0) >= 60) return true;
  return false;
}

function pickCooldownResetTime(liveQuota) {
  const now = Date.now();
  const candidates = [];
  if (liveQuota?.primary?.resetsAt && (liveQuota.primary.usedPercent ?? 0) >= 95) {
    const t = Date.parse(liveQuota.primary.resetsAt);
    if (Number.isFinite(t) && t > now) candidates.push(t);
  }
  if (liveQuota?.secondary?.resetsAt && (liveQuota.secondary.usedPercent ?? 0) >= 95) {
    const t = Date.parse(liveQuota.secondary.resetsAt);
    if (Number.isFinite(t) && t > now) candidates.push(t);
  }
  if (candidates.length === 0 && liveQuota?.primary?.resetsAt) {
    const t = Date.parse(liveQuota.primary.resetsAt);
    if (Number.isFinite(t) && t > now) candidates.push(t);
  }
  if (candidates.length > 0) {
    return {
      iso: new Date(Math.max(...candidates)).toISOString(),
      source: "official",
    };
  }
  return {
    iso: new Date(now + FALLBACK_COOLDOWN_MINUTES * 60 * 1000).toISOString(),
    source: "fallback_30m",
  };
}

function formatQuotaBrief(quota) {
  if (!quota) return "-";
  const parts = [];
  if (quota.primary) parts.push(`5h已用${quota.primary.usedPercent}%`);
  if (quota.secondary) parts.push(`周已用${quota.secondary.usedPercent}%`);
  return parts.length > 0 ? parts.join(" / ") : "-";
}

function rankAccounts(rows) {
  return [...rows].sort((a, b) => {
    const availA = a.loggedIn && !a.coolingDown ? 0 : a.loggedIn ? 1 : 2;
    const availB = b.loggedIn && !b.coolingDown ? 0 : b.loggedIn ? 1 : 2;
    if (availA !== availB) return availA - availB;

    const secA = a.lastQuota?.secondary?.usedPercent ?? (a.callCount === 0 ? 0 : 25);
    const secB = b.lastQuota?.secondary?.usedPercent ?? (b.callCount === 0 ? 0 : 25);
    if (secA !== secB) return secA - secB;

    const priA = a.lastQuota?.primary?.usedPercent ?? (a.callCount === 0 ? 0 : 25);
    const priB = b.lastQuota?.primary?.usedPercent ?? (b.callCount === 0 ? 0 : 25);
    if (priA !== priB) return priA - priB;

    const usedA = a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0;
    const usedB = b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0;
    return usedA - usedB;
  });
}

function normalizeUsage(rawUsage) {
  if (!rawUsage || typeof rawUsage !== "object") return null;
  const input = Number(rawUsage.input_tokens || 0);
  const cached = Number(rawUsage.cached_input_tokens || 0);
  const output = Number(rawUsage.output_tokens || 0);
  const total = Number(rawUsage.total_tokens || input + output);
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    totalTokens: total,
  };
}

function parseCodexJsonl(stdout) {
  let sessionId = null;
  let lastAgentText = "";
  let errorMessages = [];
  let usage = null;
  const generatedImages = [];

  const lines = stdout.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || !line.startsWith("{")) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.thread_id && !sessionId) sessionId = ev.thread_id;
      if (ev.session_id && !sessionId) sessionId = ev.session_id;
      if (ev.thread?.id && !sessionId) sessionId = ev.thread.id;

      if (ev.type === "item.completed" && ev.item) {
        const itemType = ev.item.type;
        if (itemType === "agent_message" && typeof ev.item.text === "string") {
          lastAgentText = ev.item.text;
        }
        if (
          itemType === "image_generation" ||
          itemType === "imageGeneration" ||
          itemType === "image_generation_call"
        ) {
          generatedImages.push({
            id: ev.item.id || null,
            status: ev.item.status || null,
            savedPath: ev.item.saved_path || ev.item.savedPath || null,
            revisedPrompt: ev.item.revised_prompt || ev.item.revisedPrompt || null,
            transparentBackground:
              ev.item.transparent_background ?? ev.item.transparentBackground ?? null,
            failure: ev.item.failure || null,
          });
        }
      }
      if (ev.type === "turn.completed" && ev.usage) {
        usage = normalizeUsage(ev.usage);
      }
      if (ev.type === "error" || ev.type === "turn.failed") {
        const msg = ev.message || ev.error?.message || JSON.stringify(ev);
        errorMessages.push(msg);
      }
    } catch {
      // Ignore non-JSON lines
    }
  }

  return { sessionId, lastAgentText, errorMessages, usage, generatedImages };
}

function scanGeneratedImagesDir(accountDir) {
  const genRoot = path.join(accountDir, "generated_images");
  const found = new Map();
  if (!fs.existsSync(genRoot)) return found;

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile() && /\.(png|jpe?g|webp)$/i.test(ent.name)) {
        try {
          const st = fs.statSync(full);
          if (st.size > 0) found.set(full, st.mtimeMs);
        } catch {}
      }
    }
  };
  walk(genRoot);
  return found;
}

function copyGeneratedImagesToTarget(sourcePaths, outputPath, workingDir) {
  if (!sourcePaths.length) return [];
  const copied = [];
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  let targetDir = null;
  let explicitFileBase = null;
  let explicitFileExt = ".png";

  if (typeof outputPath === "string" && outputPath.trim()) {
    const absOut = path.resolve(outputPath.trim());
    const ext = path.extname(absOut);
    if (ext && /\.(png|jpe?g|webp)$/i.test(ext)) {
      targetDir = path.dirname(absOut);
      explicitFileBase = path.basename(absOut, ext);
      explicitFileExt = ext;
    } else {
      targetDir = absOut;
    }
  } else if (workingDir && fs.existsSync(workingDir)) {
    targetDir = path.join(path.resolve(workingDir), "generated_images");
  }

  if (!targetDir) {
    return sourcePaths.map((src) => ({ source: src, saved: src }));
  }

  fs.mkdirSync(targetDir, { recursive: true });
  sourcePaths.forEach((src, idx) => {
    const srcExt = path.extname(src) || ".png";
    let destName;
    if (explicitFileBase) {
      destName =
        idx === 0
          ? `${explicitFileBase}${explicitFileExt}`
          : `${explicitFileBase}-${idx + 1}${explicitFileExt}`;
    } else {
      destName =
        idx === 0
          ? `gpt-image-${timestamp}${srcExt}`
          : `gpt-image-${timestamp}-${idx + 1}${srcExt}`;
    }
    const destPath = path.join(targetDir, destName);
    fs.copyFileSync(src, destPath);
    copied.push({ source: src, saved: destPath });
  });
  return copied;
}

function detectRateLimit(text) {
  const lower = (text || "").toLowerCase();
  return (
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("usage limit") ||
    lower.includes("usage_limit") ||
    lower.includes("too many requests") ||
    lower.includes("limit reached")
  );
}

function detectAuthError(text) {
  const lower = (text || "").toLowerCase();
  return (
    lower.includes("401") ||
    lower.includes("unauthorized") ||
    lower.includes("not logged in") ||
    lower.includes("login required") ||
    lower.includes("refresh_token") ||
    lower.includes("sign in")
  );
}

function detectUnsupportedModelError(text) {
  const lower = (text || "").toLowerCase();
  return (
    lower.includes("invalid model") ||
    lower.includes("model_not_found") ||
    lower.includes("model not found") ||
    lower.includes("unsupported model") ||
    lower.includes("not supported") ||
    lower.includes("unknown model") ||
    (lower.includes("model") && (lower.includes("does not exist") || lower.includes("not available")))
  );
}

// ---------------------------------------------------------------------------
// Optional DeepSeek API Extension (Usage + Live Balance Parity)
// ---------------------------------------------------------------------------

function loadDeepSeekConfig() {
  const envKey = (process.env.DEEPSEEK_API_KEY || "").trim();
  const envBase = (process.env.DEEPSEEK_BASE_URL || "").trim();

  let fileCfg = null;
  if (fs.existsSync(DEEPSEEK_CONFIG_PATH)) {
    try {
      const raw = fs.readFileSync(DEEPSEEK_CONFIG_PATH, "utf8").replace(/^\uFEFF/, "");
      fileCfg = JSON.parse(raw);
    } catch {
      fileCfg = null;
    }
  }

  const apiKey = envKey || (fileCfg?.apiKey || "").trim();
  const baseUrl = (envBase || fileCfg?.baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");

  return {
    configured: Boolean(apiKey),
    apiKey,
    baseUrl,
    source: envKey ? "env:DEEPSEEK_API_KEY" : fileCfg?.apiKey ? DEEPSEEK_CONFIG_PATH : null,
  };
}

function formatDeepSeekBalanceBrief(bal) {
  if (!bal || !Array.isArray(bal.balanceInfos) || bal.balanceInfos.length === 0) return "-";
  return bal.balanceInfos
    .map((b) => `${b.total_balance} ${b.currency}`)
    .join(" / ");
}

async function fetchDeepSeekBalance(cfg, timeoutMs = 5000) {
  if (!cfg?.configured) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${cfg.baseUrl}/user/balance`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return {
      fetchedAt: new Date().toISOString(),
      isAvailable: Boolean(data.is_available),
      balanceInfos: Array.isArray(data.balance_infos) ? data.balance_infos : [],
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function computeBalanceDelta(prevBal, currBal) {
  if (!prevBal?.balanceInfos?.length || !currBal?.balanceInfos?.length) return null;
  const deltas = [];
  for (const cur of currBal.balanceInfos) {
    const prev = prevBal.balanceInfos.find((p) => p.currency === cur.currency);
    if (!prev) continue;
    const prevNum = Number(prev.total_balance);
    const curNum = Number(cur.total_balance);
    if (Number.isFinite(prevNum) && Number.isFinite(curNum)) {
      deltas.push({
        currency: cur.currency,
        spent: Number((prevNum - curNum).toFixed(6)),
        remaining: cur.total_balance,
      });
    }
  }
  return deltas.length > 0 ? deltas : null;
}

function shouldRefreshDeepSeekBalance(prevBal, turnTokens) {
  if (!prevBal || !prevBal.fetchedAt) return true;
  if ((turnTokens || 0) >= 10000) return true;
  const ageMs = Date.now() - Date.parse(prevBal.fetchedAt);
  if (!Number.isFinite(ageMs) || ageMs > QUOTA_CACHE_TTL_MS) return true;
  return (prevBal.balanceInfos || []).some((b) => Number(b.total_balance) < 5);
}

function normalizeDeepSeekUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const promptTokens = Number(raw.prompt_tokens || 0);
  const cacheHitTokens = Number(raw.prompt_cache_hit_tokens || raw.prompt_tokens_details?.cached_tokens || 0);
  const cacheMissTokens = Number(raw.prompt_cache_miss_tokens || Math.max(0, promptTokens - cacheHitTokens));
  const completionTokens = Number(raw.completion_tokens || 0);
  const reasoningTokens = Number(raw.completion_tokens_details?.reasoning_tokens || 0);
  const totalTokens = Number(raw.total_tokens || promptTokens + completionTokens);
  return {
    inputTokens: promptTokens,
    cachedInputTokens: cacheHitTokens,
    cacheMissTokens,
    outputTokens: completionTokens,
    reasoningTokens,
    totalTokens,
  };
}

function deepSeekNotConfiguredResult() {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: [
          "DeepSeek 扩展尚未配置 API Key（不影响 ChatGPT Plus / Codex 功能）。",
          "任选以下一种方式本地配置后即可使用：",
          `1. 创建本地配置文件 \`${DEEPSEEK_CONFIG_PATH}\`：`,
          '```json\n{\n  "apiKey": "sk-your-deepseek-api-key",\n  "baseUrl": "https://api.deepseek.com"\n}\n```',
          "2. 或设置系统环境变量 `DEEPSEEK_API_KEY` 后重启你的 MCP 客户端。",
        ].join("\n"),
      },
    ],
  };
}

async function handleDeepSeekAsk(args = {}) {
  const cfg = loadDeepSeekConfig();
  if (!cfg.configured) return deepSeekNotConfiguredResult();

  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) {
    return { isError: true, content: [{ type: "text", text: "参数 prompt 不能为空。" }] };
  }

  const tier = args.tier === "pro" ? "pro" : "flash";
  const model = (typeof args.model === "string" && args.model.trim()) || DEEPSEEK_MODELS[tier];
  const thinkingEnabled = args.thinking !== undefined ? Boolean(args.thinking) : tier === "pro";
  const webSearch = Boolean(args.web_search);
  const timeoutMs = Math.min(Math.max(Number(args.timeout_seconds) || 120, 10), 600) * 1000;

  const messages = [];
  if (typeof args.system_prompt === "string" && args.system_prompt.trim()) {
    messages.push({ role: "system", content: args.system_prompt.trim() });
  }
  messages.push({ role: "user", content: prompt });

  const body = {
    model,
    messages,
    thinking: { type: thinkingEnabled ? "enabled" : "disabled" },
  };
  if (typeof args.max_tokens === "number" && args.max_tokens > 0) {
    body.max_tokens = Math.floor(args.max_tokens);
  }
  if (webSearch) {
    body.tools = [
      { type: "deepseek_web_search", name: "deepseek_web_search" },
      { type: "deepseek_read_url", name: "deepseek_read_url" },
    ];
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let data;
  try {
    const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `DeepSeek API 请求失败（HTTP ${resp.status}，模型：${model}）：\n${text.slice(0, 1200)}`,
          },
        ],
      };
    }
    data = JSON.parse(text);
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `DeepSeek API 调用异常：${err?.name === "AbortError" ? `超时（>${timeoutMs / 1000}s）` : err?.message || String(err)}`,
        },
      ],
    };
  } finally {
    clearTimeout(timer);
  }

  const durationSec = Number(((Date.now() - startedAt) / 1000).toFixed(1));
  const choice = data?.choices?.[0]?.message || {};
  const answer = (choice.content || "").trim() || "（DeepSeek 返回空内容）";
  const usage = normalizeDeepSeekUsage(data?.usage);
  const turnTokens = usage?.totalTokens || 0;

  const regBefore = loadRegistrySync();
  const prevBalance = regBefore.deepseek?.lastBalance || null;
  let balance = prevBalance;
  let balanceCached = true;
  let balanceDelta = null;

  if (shouldRefreshDeepSeekBalance(prevBalance, turnTokens)) {
    const liveBal = await fetchDeepSeekBalance(cfg, 5000);
    if (liveBal) {
      balanceDelta = computeBalanceDelta(prevBalance, liveBal);
      balance = liveBal;
      balanceCached = false;
    }
  }

  await mutateRegistry((reg) => {
    const ds = reg.deepseek || createEmptyDeepSeekStats();
    ds.callCount = (ds.callCount || 0) + 1;
    ds.totalTokens = (ds.totalTokens || 0) + turnTokens;
    ds.lastUsedAt = new Date().toISOString();
    ds.lastUsage = usage;
    if (balance) ds.lastBalance = balance;
    reg.deepseek = ds;
  });

  const metaBlock = JSON.stringify({
    provider: "deepseek",
    tier,
    model: data?.model || model,
    thinking: thinkingEnabled,
    webSearch,
    durationSec,
    usage,
    balance,
    balanceCached,
    balanceDelta,
  });

  return {
    content: [
      {
        type: "text",
        text: `<!-- subagent_meta:${metaBlock} -->\n${answer}`,
      },
    ],
  };
}

async function handleDeepSeekSearch(args = {}) {
  const cfg = loadDeepSeekConfig();
  if (!cfg.configured) return deepSeekNotConfiguredResult();

  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return { isError: true, content: [{ type: "text", text: "参数 query 不能为空。" }] };
  }

  const count = Math.min(Math.max(Number(args.count) || 8, 1), 20);
  const needContent = Boolean(args.need_content);
  const summarize = args.summarize !== false;
  const oriQuestion = typeof args.ori_question === "string" ? args.ori_question.trim() : undefined;

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  let rawResults = null;
  let fallbackUsed = false;

  try {
    const searchBody = {
      query: query.slice(0, 128),
      count,
      need_content: needContent,
      ...(oriQuestion ? { ori_question: oriQuestion } : {}),
    };
    const resp = await fetch(`${cfg.baseUrl}/v1/tools/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(searchBody),
      signal: controller.signal,
    });
    if (resp.ok) {
      rawResults = await resp.json();
    } else {
      fallbackUsed = true;
    }
  } catch {
    fallbackUsed = true;
  } finally {
    clearTimeout(timer);
  }

  if (fallbackUsed || !rawResults) {
    const prompt = [
      `请联网检索并整理精简、带出处的事实清单（简体中文）：`,
      `检索关键词：${query}`,
      oriQuestion ? `背景问题：${oriQuestion}` : "",
      "要求：只保留高价值事实、日期、数据与可点击来源链接，去除废话。",
    ]
      .filter(Boolean)
      .join("\n");
    return handleDeepSeekAsk({
      prompt,
      tier: "flash",
      thinking: false,
      web_search: true,
      timeout_seconds: 90,
    });
  }

  const compactJson = JSON.stringify(rawResults).slice(0, 24000);
  if (!summarize) {
    const durationSec = Number(((Date.now() - startedAt) / 1000).toFixed(1));
    const regSnap = loadRegistrySync();
    const metaBlock = JSON.stringify({
      provider: "deepseek-search",
      mode: "raw",
      query,
      durationSec,
      balance: regSnap.deepseek?.lastBalance || null,
    });
    return {
      content: [
        {
          type: "text",
          text: `<!-- subagent_meta:${metaBlock} -->\n\`\`\`json\n${compactJson}\n\`\`\``,
        },
      ],
    };
  }

  const summaryPrompt = [
    `以下是针对「${query}」的检索结果 JSON。请将其压缩成一份高信息密度的简体中文事实清单（每条附来源 URL，标注关键日期与数据，剔除广告与重复内容）：`,
    oriQuestion ? `原始问题背景：${oriQuestion}` : "",
    "",
    compactJson,
  ]
    .filter(Boolean)
    .join("\n");

  return handleDeepSeekAsk({
    prompt: summaryPrompt,
    tier: "flash",
    thinking: false,
    web_search: false,
    timeout_seconds: 90,
  });
}

// ---------------------------------------------------------------------------
// Codex Plus Tool Implementations
// ---------------------------------------------------------------------------

async function handleListAccounts(args = {}) {
  const reg = loadRegistrySync();
  const checkLive = Boolean(args.check_live_status);
  const includeLiveQuota = Boolean(args.include_live_quota);

  const entries = Object.entries(reg.accounts);
  const freshQuotas = {};

  const rows = await Promise.all(
    entries.map(async ([name, meta]) => {
      const auth = getAuthInfo(name);
      const cooling = isCoolingDown(meta);
      let liveStatus = null;
      let effectiveQuota = meta.lastQuota || null;

      if (checkLive && auth.loggedIn) {
        const res = await runCodexProcess({
          accountDir: ensureAccountDir(name),
          args: ["login", "status"],
          timeoutSec: 20,
        });
        liveStatus = (res.stdout || res.stderr || "").trim().replace(/\s+/g, " ");
      }

      if (includeLiveQuota && auth.loggedIn) {
        const fresh = await fetchLiveRateLimits(ensureAccountDir(name), QUOTA_QUERY_TIMEOUT_MS);
        if (fresh) {
          effectiveQuota = fresh;
          freshQuotas[name] = fresh;
        }
      }

      return {
        account: name,
        label: meta.label,
        loggedIn: auth.loggedIn,
        coolingDown: cooling,
        defaultModel: meta.defaultModel || "(默认)",
        callCount: meta.callCount || 0,
        totalTokens: meta.totalTokens || 0,
        lastUsedAt: meta.lastUsedAt,
        lastQuota: effectiveQuota,
        quotaBrief: formatQuotaBrief(effectiveQuota),
        lastSessionId: meta.lastSessionId,
        recentSessions: (meta.recentSessions || []).slice(0, 8),
        status: !auth.loggedIn
          ? "未登录"
          : cooling
            ? `冷却中（至 ${meta.cooldownUntil}）`
            : "可用",
        lastError: meta.lastError,
        ...(checkLive ? { liveStatus } : {}),
      };
    })
  );

  const dsCfg = loadDeepSeekConfig();
  let dsBalance = reg.deepseek?.lastBalance || null;
  let dsFreshBalance = null;
  if (includeLiveQuota && dsCfg.configured) {
    dsFreshBalance = await fetchDeepSeekBalance(dsCfg, 5000);
    if (dsFreshBalance) dsBalance = dsFreshBalance;
  }

  if (Object.keys(freshQuotas).length > 0 || dsFreshBalance) {
    await mutateRegistry((latest) => {
      for (const [k, q] of Object.entries(freshQuotas)) {
        if (latest.accounts[k]) latest.accounts[k].lastQuota = q;
      }
      if (dsFreshBalance) {
        latest.deepseek = latest.deepseek || createEmptyDeepSeekStats();
        latest.deepseek.lastBalance = dsFreshBalance;
      }
    });
  }

  const ranked = rankAccounts(rows);
  const topCandidate = ranked.find((r) => r.loggedIn && !r.coolingDown) || null;
  const recommendedAccount = topCandidate ? topCandidate.account : null;

  const deepseekSummary = {
    configured: dsCfg.configured,
    balanceBrief: formatDeepSeekBalanceBrief(dsBalance),
    lastBalance: dsBalance,
    callCount: reg.deepseek?.callCount || 0,
    totalTokens: reg.deepseek?.totalTokens || 0,
  };

  const lines = [
    "### ChatGPT Plus 账号池状态（按余量推荐排序）",
    recommendedAccount
      ? `> 推荐账号：\`${recommendedAccount}\`（${topCandidate.label} · ${topCandidate.quotaBrief}）`
      : "> 当前无可用的已登录非冷却账号",
    "",
    "| 账号 ID | 备注 | 状态 | 额度快照 | 调用次数 | 最近活跃会话 |",
    "| :--- | :--- | :--- | :--- | :--- | :--- |",
    ...ranked.map((r) => {
      const topSession = r.recentSessions[0];
      const sessSummary = topSession
        ? `${topSession.topic} (${topSession.turnCount}轮)`
        : "-";
      const recMark = r.account === recommendedAccount ? " ⭐" : "";
      return `| \`${r.account}\`${recMark} | ${r.label} | ${r.status} | ${r.quotaBrief} | ${r.callCount} | ${sessSummary} |`;
    }),
    "",
    dsCfg.configured
      ? `> DeepSeek 扩展：已配置 | 余额：${deepseekSummary.balanceBrief} | 累计调用 ${deepseekSummary.callCount} 次`
      : "> DeepSeek 扩展：未配置（可选）",
    "",
    "```json",
    JSON.stringify(
      {
        recommendedAccount,
        accounts: ranked,
        modelTiers: reg.modelTiers,
        deepseek: deepseekSummary,
      },
      null,
      2
    ),
    "```",
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function handleManageAccount(args = {}) {
  const { action, account, value } = args;

  if (action === "add_account") {
    if (!validateAccountName(account)) {
      return {
        isError: true,
        content: [{ type: "text", text: `无效的账号名 "${account}"，仅允许字母、数字、下划线和连字符。` }],
      };
    }
    let alreadyExists = false;
    await mutateRegistry((reg) => {
      if (reg.accounts[account]) {
        alreadyExists = true;
        return;
      }
      reg.accounts[account] = createEmptyAccountMeta(value || `Plus Account (${account})`);
    });
    if (alreadyExists) {
      return { isError: true, content: [{ type: "text", text: `账号 "${account}" 已存在。` }] };
    }
    ensureAccountDir(account);
    return {
      content: [
        {
          type: "text",
          text: `已新增隔离账号 \`${account}\`，请运行以下命令完成 OAuth 登录：\n\`${getLoginInstruction(account)}\``,
        },
      ],
    };
  }

  const snap = loadRegistrySync();
  const resolvedKey = resolveAccountKey(snap, account);
  if (!resolvedKey) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `找不到账号 "${account}"。当前可用账号：${Object.entries(snap.accounts)
            .map(([k, m]) => `${k}(${m.label})`)
            .join(", ")}`,
        },
      ],
    };
  }

  if (action === "set_note") {
    let newLabel = "";
    await mutateRegistry((reg) => {
      const meta = reg.accounts[resolvedKey];
      meta.label = value || meta.label;
      newLabel = meta.label;
    });
    return { content: [{ type: "text", text: `已将 \`${resolvedKey}\` 备注更新为：${newLabel}` }] };
  }

  if (action === "set_model") {
    const nextModel = value || "";
    await mutateRegistry((reg) => {
      reg.accounts[resolvedKey].defaultModel = nextModel;
    });
    return {
      content: [
        {
          type: "text",
          text: `已将 \`${resolvedKey}\` 默认模型更新为：${nextModel || "(跟随档位/Codex CLI 默认)"}`,
        },
      ],
    };
  }

  if (action === "clear_cooldown") {
    await mutateRegistry((reg) => {
      reg.accounts[resolvedKey].cooldownUntil = null;
      reg.accounts[resolvedKey].lastError = null;
    });
    return { content: [{ type: "text", text: `已清除 \`${resolvedKey}\` 的冷却/异常标记。` }] };
  }

  return {
    isError: true,
    content: [{ type: "text", text: `不支持的操作 action="${action}"。` }],
  };
}

function buildCodexCliArgs({
  resumeSessionId,
  sandbox,
  worktree,
  working_dir,
  chosenModel,
  chosenEffort,
  imagePaths,
  enableFeatures = [],
  tmpOutFile,
}) {
  const cliArgs = [];
  if (resumeSessionId !== null) {
    cliArgs.push("exec", "resume", "--json", "--skip-git-repo-check", "-o", tmpOutFile);
    if (resumeSessionId === "__LAST__") {
      cliArgs.push("--last");
    }
    if (chosenModel) cliArgs.push("-m", chosenModel);
    if (chosenEffort) cliArgs.push("-c", `model_reasoning_effort="${chosenEffort}"`);
    for (const feat of enableFeatures) {
      cliArgs.push("--enable", feat);
    }
    for (const img of imagePaths) {
      cliArgs.push("-i", img);
    }
    // Prevent clap's greedy num_args=1.. on -i from swallowing positional args / "-" (Codex Issue #40695)
    if (imagePaths.length > 0) {
      cliArgs.push("--");
    }
    if (resumeSessionId === "__LAST__") {
      cliArgs.push("-");
    } else {
      cliArgs.push(resumeSessionId, "-");
    }
  } else {
    const safeSandbox = worktree || sandbox === "workspace-write" ? "workspace-write" : "read-only";
    cliArgs.push(
      "exec",
      "--json",
      "--sandbox",
      safeSandbox,
      "--skip-git-repo-check",
      "--color",
      "never",
      "-o",
      tmpOutFile
    );
    if (worktree) {
      cliArgs.push("--worktree");
    }
    if (working_dir && fs.existsSync(working_dir)) {
      cliArgs.push("-C", working_dir);
    }
    if (chosenModel) {
      cliArgs.push("-m", chosenModel);
    }
    if (chosenEffort) {
      cliArgs.push("-c", `model_reasoning_effort="${chosenEffort}"`);
    }
    for (const feat of enableFeatures) {
      cliArgs.push("--enable", feat);
    }
    for (const img of imagePaths) {
      cliArgs.push("-i", img);
    }
    // Prevent clap's greedy num_args=1.. on -i from swallowing "-" (Codex Issue #40695)
    if (imagePaths.length > 0) {
      cliArgs.push("--");
    }
    cliArgs.push("-");
  }
  return cliArgs;
}

async function runHeadlessCodex({
  account,
  prompt,
  topic = "",
  working_dir,
  sandbox = "read-only",
  worktree = false,
  images = null,
  tier = null,
  model,
  reasoning_effort = "",
  timeout_seconds,
  resumeSessionId = null,
  enableFeatures = [],
  forceQuotaRefresh = false,
  collectGeneratedImages = false,
  outputPath = null,
  providerTag = "codex-plus",
}) {
  const regSnap = loadRegistrySync();
  const resolvedKey = resolveAccountKey(regSnap, account);
  if (!resolvedKey) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `未知账号 "${account}"。可用账号：${Object.entries(regSnap.accounts)
            .map(([k, m]) => `${k}(${m.label})`)
            .join(", ")}`,
        },
      ],
    };
  }

  const metaSnap = regSnap.accounts[resolvedKey];
  const auth = getAuthInfo(resolvedKey);
  if (!auth.loggedIn) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `账号 \`${resolvedKey}\`（${metaSnap.label}）尚未登录。请先执行授权命令：\n\`${getLoginInstruction(resolvedKey)}\``,
        },
      ],
    };
  }

  const imgCheck = validateImages(images);
  if (!imgCheck.ok) {
    return { isError: true, content: [{ type: "text", text: imgCheck.error }] };
  }

  const useWorktree = Boolean(worktree) && resumeSessionId === null;
  if (useWorktree) {
    if (!working_dir || !fs.existsSync(working_dir)) {
      return {
        isError: true,
        content: [{ type: "text", text: "开启 worktree=true 时必须传入存在的 Git 仓库目录 working_dir。" }],
      };
    }
    if (!isGitRepository(working_dir)) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `开启 worktree=true 失败：目录 "${working_dir}" 不是有效的 Git 仓库（未找到 .git）。`,
          },
        ],
      };
    }
  }

  const accountDir = ensureAccountDir(resolvedKey);
  const resolvedTier = resolveTierConfig(
    regSnap,
    tier,
    model,
    reasoning_effort,
    metaSnap.defaultModel
  );
  const effectiveSandbox = useWorktree || sandbox === "workspace-write" ? "workspace-write" : "read-only";
  const tmpOutFile = path.join(os.tmpdir(), `codex-out-${crypto.randomUUID()}.txt`);
  const prevQuota = metaSnap.lastQuota || null;
  const beforeGenImages = collectGeneratedImages ? scanGeneratedImagesDir(accountDir) : null;
  const runStartMs = Date.now();

  try {
    let activeModel = resolvedTier.model;
    let modelFallback = false;
    let originalRequestedModel = activeModel || null;

    const executeAttempt = async (modelToUse) => {
      try {
        if (fs.existsSync(tmpOutFile)) fs.unlinkSync(tmpOutFile);
      } catch {}
      const cliArgs = buildCodexCliArgs({
        resumeSessionId,
        sandbox: effectiveSandbox,
        worktree: useWorktree,
        working_dir,
        chosenModel: modelToUse,
        chosenEffort: resolvedTier.reasoningEffort,
        imagePaths: imgCheck.paths,
        enableFeatures,
        tmpOutFile,
      });
      return runCodexProcess({
        accountDir,
        args: cliArgs,
        stdinText: prompt,
        cwd: working_dir || process.cwd(),
        timeoutSec: timeout_seconds || DEFAULT_TIMEOUT_SEC,
      });
    };

    let res = await executeAttempt(activeModel);
    let finalMessage = fs.existsSync(tmpOutFile) ? fs.readFileSync(tmpOutFile, "utf8").trim() : "";
    let parsed = parseCodexJsonl(res.stdout);
    if (!finalMessage && parsed.lastAgentText) finalMessage = parsed.lastAgentText.trim();

    let combinedDiagnostics = [
      ...parsed.errorMessages,
      res.stderr,
      !finalMessage ? res.stdout.slice(-1500) : "",
    ]
      .filter(Boolean)
      .join("\n");

    if (
      activeModel &&
      resolvedTier.cameFromTier &&
      !res.timedOut &&
      (res.code !== 0 || (!finalMessage && parsed.errorMessages.length > 0)) &&
      detectUnsupportedModelError(combinedDiagnostics)
    ) {
      modelFallback = true;
      activeModel = "";
      res = await executeAttempt("");
      finalMessage = fs.existsSync(tmpOutFile) ? fs.readFileSync(tmpOutFile, "utf8").trim() : "";
      parsed = parseCodexJsonl(res.stdout);
      if (!finalMessage && parsed.lastAgentText) finalMessage = parsed.lastAgentText.trim();
      combinedDiagnostics = [
        ...parsed.errorMessages,
        res.stderr,
        !finalMessage ? res.stdout.slice(-1500) : "",
      ]
        .filter(Boolean)
        .join("\n");
    }

    const activeSessionId =
      parsed.sessionId ||
      (resumeSessionId && resumeSessionId !== "__LAST__" ? resumeSessionId : metaSnap.lastSessionId);

    if (res.timedOut) {
      await mutateRegistry((reg) => {
        const m = reg.accounts[resolvedKey];
        if (!m) return;
        m.lastUsedAt = new Date().toISOString();
        m.callCount = (m.callCount || 0) + 1;
        m.lastError = `调用超时（>${timeout_seconds || DEFAULT_TIMEOUT_SEC}s）`;
      });
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `账号 \`${resolvedKey}\`（${metaSnap.label}）执行超时（${Math.round(res.durationMs / 1000)}s），已清理整个子进程树。`,
          },
        ],
      };
    }

    if (res.code !== 0 || (!finalMessage && parsed.errorMessages.length > 0)) {
      if (detectRateLimit(combinedDiagnostics)) {
        const liveQuotaOn429 = await fetchLiveRateLimits(accountDir, QUOTA_QUERY_TIMEOUT_MS);
        const cooldown = pickCooldownResetTime(liveQuotaOn429);

        let alternatives = [];
        await mutateRegistry((reg) => {
          const m = reg.accounts[resolvedKey];
          if (m) {
            m.lastUsedAt = new Date().toISOString();
            m.callCount = (m.callCount || 0) + 1;
            m.cooldownUntil = cooldown.iso;
            m.lastError = "触发 ChatGPT Plus 额度/频率限制（429）";
            if (liveQuotaOn429) m.lastQuota = liveQuotaOn429;
          }
          alternatives = Object.entries(reg.accounts)
            .filter(([k, acc]) => k !== resolvedKey && getAuthInfo(k).loggedIn && !isCoolingDown(acc))
            .map(([k, acc]) => `\`${k}\`（${acc.label} · ${formatQuotaBrief(acc.lastQuota)}）`);
        });

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: [
                `账号 \`${resolvedKey}\`（${metaSnap.label}）触发限流，已标记冷却至 ${cooldown.iso}（来源：${cooldown.source === "official" ? "官方重置时间" : "默认 30 分钟回退"}）。`,
                alternatives.length > 0
                  ? `可用备用账号：${alternatives.join("、")}（切号时请将当前进度压缩为摘要后用 codex_exec 续跑，勿用旧 session_id）`
                  : "当前暂无其他未冷却的备用账号。",
                "",
                combinedDiagnostics.slice(0, 1000),
              ].join("\n"),
            },
          ],
        };
      }

      if (detectAuthError(combinedDiagnostics)) {
        await mutateRegistry((reg) => {
          const m = reg.accounts[resolvedKey];
          if (!m) return;
          m.lastUsedAt = new Date().toISOString();
          m.callCount = (m.callCount || 0) + 1;
          m.lastError = "登录态失效，需要重新登录";
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `账号 \`${resolvedKey}\`（${metaSnap.label}）登录态失效，请重新登录：\n\`${getLoginInstruction(resolvedKey)}\``,
            },
          ],
        };
      }

      await mutateRegistry((reg) => {
        const m = reg.accounts[resolvedKey];
        if (!m) return;
        m.lastUsedAt = new Date().toISOString();
        m.callCount = (m.callCount || 0) + 1;
        m.lastError = `退出码 ${res.code}`;
      });
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Codex CLI 执行失败（账号：\`${resolvedKey}\`，退出码：${res.code}）：\n\n${combinedDiagnostics.slice(0, 1500)}`,
          },
        ],
      };
    }

    const turnUsage = parsed.usage;
    const turnTokens = turnUsage?.totalTokens || 0;
    let effectiveQuota = prevQuota;
    let quotaCached = true;
    let quotaDelta = null;

    if (forceQuotaRefresh || shouldRefreshQuota(prevQuota, turnTokens)) {
      const liveQuota = await fetchLiveRateLimits(accountDir, QUOTA_QUERY_TIMEOUT_MS);
      if (liveQuota) {
        if (
          prevQuota?.primary &&
          liveQuota.primary &&
          prevQuota.primary.resetsAt === liveQuota.primary.resetsAt
        ) {
          quotaDelta = {
            primaryDeltaPercent: liveQuota.primary.usedPercent - prevQuota.primary.usedPercent,
            secondaryDeltaPercent:
              prevQuota.secondary && liveQuota.secondary
                ? liveQuota.secondary.usedPercent - prevQuota.secondary.usedPercent
                : null,
          };
        }
        effectiveQuota = liveQuota;
        quotaCached = false;
      }
    }

    let copiedImages = [];
    let imageFailures = [];
    let revisedPrompts = [];
    if (collectGeneratedImages || (parsed.generatedImages && parsed.generatedImages.length > 0)) {
      const sourcePathSet = new Set();
      for (const item of parsed.generatedImages || []) {
        if (item.failure) imageFailures.push(item.failure);
        if (item.revisedPrompt) revisedPrompts.push(item.revisedPrompt);
        if (item.savedPath && fs.existsSync(item.savedPath)) {
          sourcePathSet.add(path.resolve(item.savedPath));
        }
      }
      if (collectGeneratedImages) {
        const afterGenImages = scanGeneratedImagesDir(accountDir);
        for (const [imgFile, mtimeMs] of afterGenImages.entries()) {
          const prevMtime = beforeGenImages?.get(imgFile);
          if (prevMtime === undefined || mtimeMs > prevMtime || mtimeMs >= runStartMs - 2000) {
            sourcePathSet.add(path.resolve(imgFile));
          }
        }
      }
      const uniqueSources = [...sourcePathSet];
      if (uniqueSources.length > 0) {
        copiedImages = copyGeneratedImagesToTarget(uniqueSources, outputPath, working_dir);
      }
    }

    let turnCount = 1;
    await mutateRegistry((reg) => {
      const m = reg.accounts[resolvedKey];
      if (!m) return;
      m.lastUsedAt = new Date().toISOString();
      m.callCount = (m.callCount || 0) + 1;
      m.totalTokens = (m.totalTokens || 0) + turnTokens;
      m.lastUsage = turnUsage;
      m.cooldownUntil = null;
      m.lastError = null;
      if (!quotaCached && effectiveQuota) {
        m.lastQuota = effectiveQuota;
      }
      recordSessionUsage(m, {
        sessionId: activeSessionId,
        topic: topic || prompt.replace(/\s+/g, " ").trim().slice(0, 36),
        workingDir: working_dir || "",
        isResume: resumeSessionId !== null,
        turnTokens,
      });
      turnCount =
        m.recentSessions.find((s) => s.sessionId === activeSessionId)?.turnCount || 1;
    });

    const metaBlock = JSON.stringify({
      provider: providerTag,
      account: resolvedKey,
      label: metaSnap.label,
      mode: resumeSessionId ? "resume" : effectiveSandbox,
      ...(useWorktree ? { worktree: true } : {}),
      ...(imgCheck.paths.length > 0 ? { imageCount: imgCheck.paths.length } : {}),
      ...(copiedImages.length > 0 ? { generatedFiles: copiedImages.map((c) => c.saved) } : {}),
      ...(revisedPrompts.length > 0 ? { revisedPrompts } : {}),
      ...(imageFailures.length > 0 ? { imageFailures } : {}),
      tier: resolvedTier.tier || "(未指定)",
      model: activeModel || "(CLI默认)",
      ...(modelFallback ? { modelFallback: true, originalRequestedModel } : {}),
      reasoningEffort: resolvedTier.reasoningEffort || "(默认)",
      sessionId: activeSessionId,
      turnCount,
      durationSec: Number((res.durationMs / 1000).toFixed(1)),
      usage: turnUsage,
      quota: effectiveQuota || null,
      quotaCached,
      quotaDelta,
    });

    if (collectGeneratedImages && copiedImages.length === 0) {
      const failDetail =
        imageFailures.length > 0
          ? `图片生成失败：${JSON.stringify(imageFailures)}`
          : "未检测到新生成的图片文件（请检查该账号是否支持 image_generation，或模型是否拒绝了提示词）。";
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `<!-- subagent_meta:${metaBlock} -->\n${failDetail}\n\nCodex 返回说明：\n${finalMessage || "（无）"}`,
          },
        ],
      };
    }

    const bodyLines = [];
    if (copiedImages.length > 0) {
      bodyLines.push("### 已生成图片文件");
      copiedImages.forEach((c, idx) => {
        bodyLines.push(`- 图片 ${idx + 1}：\`${c.saved}\``);
      });
      if (revisedPrompts.length > 0) {
        bodyLines.push(`- 实际生图提示词：${revisedPrompts[0]}`);
      }
      bodyLines.push("");
    }
    bodyLines.push(finalMessage || "（Codex 返回空内容）");

    return {
      content: [
        {
          type: "text",
          text: `<!-- subagent_meta:${metaBlock} -->\n${bodyLines.join("\n")}`,
        },
      ],
    };
  } finally {
    try {
      if (fs.existsSync(tmpOutFile)) fs.unlinkSync(tmpOutFile);
    } catch {}
  }
}

async function handleGenerateImage(args = {}) {
  const promptText = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!promptText) {
    return { isError: true, content: [{ type: "text", text: "参数 prompt 不能为空。" }] };
  }

  const refImages = args.reference_images ?? args.images ?? null;
  const imgCheck = validateImages(refImages);
  if (!imgCheck.ok) {
    return { isError: true, content: [{ type: "text", text: imgCheck.error }] };
  }

  const sizeHint = typeof args.size === "string" && args.size.trim() ? args.size.trim() : "auto";
  const qualityHint = typeof args.quality === "string" && args.quality.trim() ? args.quality.trim() : "high";
  const transparent = Boolean(args.transparent_background);

  const instructionLines = [
    "请使用内置的 image_generation 工具直接生成图片，不要编写脚本、不要修改工作区文件、也不要只输出文字描述。",
    imgCheck.paths.length > 0
      ? `我已通过命令行附带了 ${imgCheck.paths.length} 张参考图/原图，请先仔细阅读这些图片，并基于它们按下方要求进行编辑或重绘。`
      : "",
    `生成要求：${promptText}`,
    sizeHint !== "auto" ? `尺寸/比例要求：${sizeHint}` : "",
    qualityHint !== "auto" ? `画质要求：${qualityHint}` : "",
    transparent ? "背景要求：透明背景（transparent background）。" : "",
    "生成完成后，请简明回复你对成图构图与细节的 2–3 句中文说明即可。",
  ].filter(Boolean);

  return runHeadlessCodex({
    account: args.account,
    prompt: instructionLines.join("\n"),
    topic: `GPT生图: ${promptText.slice(0, 28)}`,
    working_dir: args.working_dir,
    sandbox: "read-only",
    images: imgCheck.paths.length > 0 ? imgCheck.paths : null,
    tier: args.tier || null,
    model: args.model,
    reasoning_effort: args.reasoning_effort || "medium",
    timeout_seconds: args.timeout_seconds || DEFAULT_TIMEOUT_SEC,
    enableFeatures: ["image_generation"],
    forceQuotaRefresh: true,
    collectGeneratedImages: true,
    outputPath: args.output_path || null,
    providerTag: "codex-plus-image",
  });
}

// ---------------------------------------------------------------------------
// MCP Tool Definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "codex_list_accounts",
    description:
      "查询所有已注册 ChatGPT Plus 隔离账号的状态、备注、额度快照（按余量推荐排序并返回 recommendedAccount）、最近命名会话列表，以及可选 DeepSeek 扩展余额状态。设置 include_live_quota=true 可并行拉取所有账号及 DeepSeek 的实时官方额度。",
    inputSchema: {
      type: "object",
      properties: {
        check_live_status: {
          type: "boolean",
          description: "是否实时验证 OAuth 登录态（默认 false）。",
        },
        include_live_quota: {
          type: "boolean",
          description: "是否实时拉取所有 Plus 账号的官方 5h/周额度及 DeepSeek 余额（默认 false 使用缓存）。",
        },
      },
    },
  },
  {
    name: "codex_manage_account",
    description:
      "管理 ChatGPT Plus 账号池元数据（改备注、设默认模型、清冷却、新增账号）。",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["set_note", "set_model", "clear_cooldown", "add_account"],
          description: "管理操作类型。",
        },
        account: {
          type: "string",
          description: "账号 ID 或自定义备注名（如 plus-1 或 personal）。",
        },
        value: {
          type: "string",
          description: "新备注或模型名称。",
        },
      },
      required: ["action", "account"],
    },
  },
  {
    name: "codex_exec",
    description:
      "以子 Agent 形式启动新的 Codex (ChatGPT Plus) 会话执行任务。支持模型分级路由（tier）、本地图片附件（images）和独立 Git worktree 隔离写入（worktree）。若 tier 模型不被账号支持会自动回退 CLI 默认模型。",
    inputSchema: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description: "必填：已选定的 Plus 账号 ID 或自定义备注名（如 plus-1 或 personal）。",
        },
        prompt: {
          type: "string",
          description: "必填：发送给 GPT 子 Agent 的结构化任务单。",
        },
        topic: {
          type: "string",
          description: "推荐：主 Agent 自动总结的简短主题名（如「数学建模核验」「代码评审」）。",
        },
        working_dir: {
          type: "string",
          description: "可选：工作目录绝对路径（worktree=true 时必填有效 Git 仓库）。",
        },
        sandbox: {
          type: "string",
          enum: ["read-only", "workspace-write"],
          description: "默认 read-only（单写原则）；worktree=true 时自动启用 workspace-write。",
        },
        worktree: {
          type: "boolean",
          description: "可选：是否在独立 Git worktree 中隔离写入（默认 false；开启前自动校验 Git 仓库）。",
        },
        images: {
          type: "array",
          items: { type: "string" },
          description: "可选：本地图片绝对路径数组（论文图表、公式或报错截图），底层透传 -i。",
        },
        tier: {
          type: "string",
          enum: ["economy", "balanced", "flagship", "vision"],
          description: "可选：模型分级路由（economy=gpt-6-luna 轻量初筛；balanced=gpt-6.2-sol 日常代码/审查；flagship=gpt-6.2-astra 科研推导/疑难Debug；vision=gpt-6.1-terra 视觉核验）。",
        },
        model: {
          type: "string",
          description: "可选：显式指定模型名（优先级高于 tier）。",
        },
        reasoning_effort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh"],
          description: "可选：推理深度分层（常规 high；核心科研证明、数学建模关键推导、复杂算法、资金/数据/权限安全用 xhigh）。",
        },
        timeout_seconds: {
          type: "number",
          description: "可选：超时秒数（默认 300，最大 900）。",
        },
      },
      required: ["account", "prompt"],
    },
  },
  {
    name: "codex_resume",
    description:
      "让 GPT 子 Agent 在已有长对话线程中继续推进同一主题以命中 Prompt Cache（支持传图 images 和 tier/reasoning_effort）。严禁跨账号传旧 session_id。",
    inputSchema: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description: "必填：原会话所属的 Plus 账号 ID 或自定义备注名。",
        },
        prompt: {
          type: "string",
          description: "必填：追问或下一阶段子任务指令。",
        },
        session_id: {
          type: "string",
          description: "可选：主 Agent 从上下文或 recentSessions 匹配到的 sessionId（不填自动续聊该账号最近会话）。",
        },
        topic: {
          type: "string",
          description: "可选：更新该会话的主题摘要。",
        },
        working_dir: {
          type: "string",
          description: "可选：工作目录绝对路径。",
        },
        images: {
          type: "array",
          items: { type: "string" },
          description: "可选：补充的本地图片绝对路径数组。",
        },
        tier: {
          type: "string",
          enum: ["economy", "balanced", "flagship", "vision"],
          description: "可选：模型分级路由。",
        },
        model: {
          type: "string",
          description: "可选：显式指定模型名。",
        },
        reasoning_effort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh"],
          description: "可选：推理深度（常规 high，关键证明/高风险 xhigh）。",
        },
        timeout_seconds: {
          type: "number",
          description: "可选：超时秒数（默认 300）。",
        },
      },
      required: ["account", "prompt"],
    },
  },
  {
    name: "codex_review",
    description:
      "使用指定 Plus 账号以严格只读模式执行两阶段分级审查（先查 Spec 合规，再查 P0 阻断/P1 建议，防过度吹毛求疵）。默认 balanced 档 + high 推理，高危场景可升 flagship/xhigh。",
    inputSchema: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description: "必填：Plus 账号 ID 或自定义备注名。",
        },
        working_dir: {
          type: "string",
          description: "必填：项目目录绝对路径。",
        },
        focus: {
          type: "string",
          description: "可选：重点审查方向或 Spec 验收要点。",
        },
        tier: {
          type: "string",
          enum: ["economy", "balanced", "flagship", "vision"],
          description: "可选：模型分级，默认 balanced（gpt-6.2-sol）；核心安全/科研推导可升 flagship。",
        },
        model: {
          type: "string",
          description: "可选：显式指定审查模型。",
        },
        reasoning_effort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh"],
          description: "可选：推理深度，默认 high；涉及资金/数据安全/权限登录/核心算法或公式证明时传 xhigh。",
        },
        timeout_seconds: {
          type: "number",
          description: "可选：超时秒数（默认 300）。",
        },
      },
      required: ["account", "working_dir"],
    },
  },
  {
    name: "codex_generate_image",
    description:
      "使用指定的 ChatGPT Plus 账号通过 Codex CLI 原生 --enable image_generation 生成或编辑图片（零额外 API 费用，走 Plus 订阅额度）。支持传 reference_images 先读图再改图/图生图、透明底、自定义保存路径 output_path，并自动刷新真实 Plus 额度。",
    inputSchema: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description: "必填：已选定的 Plus 账号 ID 或自定义备注名（如 plus-1 或 personal）。",
        },
        prompt: {
          type: "string",
          description: "必填：详细的生图或改图提示词（建议写清主体、构图、风格、文字标签与配色）。",
        },
        output_path: {
          type: "string",
          description: "可选：目标图片文件绝对路径或目标目录路径；不填时若提供了 working_dir 则默认存到 working_dir/generated_images/。",
        },
        reference_images: {
          type: "array",
          items: { type: "string" },
          description: "可选：本地参考图/原图绝对路径数组（先让 GPT 读图，再基于原图做修改、重绘或风格迁移）。",
        },
        working_dir: {
          type: "string",
          description: "可选：工作区目录绝对路径。",
        },
        size: {
          type: "string",
          description: "可选：目标尺寸或比例提示（如 1024x1024、1536x1024、1024x1536、16:9，默认 auto）。",
        },
        quality: {
          type: "string",
          enum: ["low", "medium", "high", "auto"],
          description: "可选：画质档位（默认 high）。",
        },
        transparent_background: {
          type: "boolean",
          description: "可选：是否要求透明背景（默认 false）。",
        },
        tier: {
          type: "string",
          enum: ["economy", "balanced", "flagship", "vision"],
          description: "可选：驱动生图工具的代理模型档位（通常留空跟随 CLI 默认即可）。",
        },
        model: {
          type: "string",
          description: "可选：显式指定驱动模型名。",
        },
        reasoning_effort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh"],
          description: "可选：驱动代理推理深度（默认 medium，减少生图等待时间）。",
        },
        timeout_seconds: {
          type: "number",
          description: "可选：超时秒数（默认 300）。",
        },
      },
      required: ["account", "prompt"],
    },
  },
  {
    name: "deepseek_ask",
    description:
      "调用 DeepSeek API（低成本批量预读、资料降噪、实体关系抽取或深度推理备胎），支持 flash（deepseek-flash）和 pro（deepseek-v4-pro）两档及可选服务端联网搜索，返回与 GPT 一致的 Token 用量与真实账户余额。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "必填：发送给 DeepSeek 的任务提示词。",
        },
        system_prompt: {
          type: "string",
          description: "可选：系统提示词。",
        },
        tier: {
          type: "string",
          enum: ["flash", "pro"],
          description: "模型档位：flash=deepseek-flash（默认，1M 上下文低成本预读/抽取），pro=deepseek-v4-pro（深度推理备胎）。",
        },
        model: {
          type: "string",
          description: "可选：显式指定 DeepSeek 模型名。",
        },
        thinking: {
          type: "boolean",
          description: "可选：是否开启思考模式（flash 默认 false，pro 默认 true）。",
        },
        web_search: {
          type: "boolean",
          description: "可选：是否开启 DeepSeek 服务端联网搜索与读链接（默认 false）。",
        },
        max_tokens: {
          type: "number",
          description: "可选：最大输出 Token 数。",
        },
        timeout_seconds: {
          type: "number",
          description: "可选：超时秒数（默认 120）。",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "deepseek_search",
    description:
      "调用 DeepSeek 联网检索与网页摘要能力（优先 /v1/tools/search，不可用时自动降级为 deepseek-flash 联网检索），返回精简带出处的事实清单并记录 Token 用量与余额。",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "必填：检索关键词（1–128 字符，支持 site: 与引号语法）。",
        },
        ori_question: {
          type: "string",
          description: "可选：用户的原始问题背景，辅助更精准检索与摘要。",
        },
        count: {
          type: "number",
          description: "可选：返回结果条数（默认 8，范围 1–20）。",
        },
        need_content: {
          type: "boolean",
          description: "可选：是否拉取网页正文（默认 false）。",
        },
        summarize: {
          type: "boolean",
          description: "可选：是否用 deepseek-flash 压缩成带出处的精简事实清单（默认 true）。",
        },
      },
      required: ["query"],
    },
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 Stdio Server Loop
// ---------------------------------------------------------------------------

function sendJson(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  if (id === undefined || id === null) {
    return;
  }

  try {
    if (method === "initialize") {
      sendJson({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "codex-plus-bridge",
            version: SERVER_VERSION,
          },
        },
      });
      return;
    }

    if (method === "ping") {
      sendJson({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    if (method === "resources/list") {
      sendJson({ jsonrpc: "2.0", id, result: { resources: [] } });
      return;
    }

    if (method === "resources/templates/list") {
      sendJson({ jsonrpc: "2.0", id, result: { resourceTemplates: [] } });
      return;
    }

    if (method === "prompts/list") {
      sendJson({ jsonrpc: "2.0", id, result: { prompts: [] } });
      return;
    }

    if (method === "tools/list") {
      sendJson({
        jsonrpc: "2.0",
        id,
        result: { tools: TOOLS },
      });
      return;
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      let result;

      if (toolName === "codex_list_accounts") {
        result = await handleListAccounts(toolArgs);
      } else if (toolName === "codex_manage_account") {
        result = await handleManageAccount(toolArgs);
      } else if (toolName === "codex_exec") {
        result = await runHeadlessCodex(toolArgs);
      } else if (toolName === "codex_resume") {
        const reg = loadRegistrySync();
        const key = resolveAccountKey(reg, toolArgs.account);
        const fallbackSid = (key && reg.accounts[key]?.lastSessionId) || "__LAST__";
        result = await runHeadlessCodex({
          ...toolArgs,
          resumeSessionId: toolArgs.session_id || fallbackSid,
        });
      } else if (toolName === "codex_review") {
        const reviewPrompt = [
          "请以严格只读模式对当前工作区执行「两阶段分级审查」（优先审查 git status / git diff 未提交改动，若无未提交改动则审查核心代码与逻辑）：",
          toolArgs.focus ? `Spec / 重点审查范围：${toolArgs.focus}` : "",
          "请按以下结构输出简体中文报告（禁止吹毛求疵）：",
          "1. 【阶段一：Spec 合规性】是否完整满足目标与接口约束，有无漏改同类位置。",
          "2. 【阶段二：P0 阻断级（必须修）】仅限会导致算错数/公式错误、丢数据、越权/安全漏洞、崩溃、对外误发或核心逻辑硬伤的问题，且每一条必须写明「具体可复现的触发路径 + 文件行号 + 修复建议」。说不出触发路径的不要放 P0。",
          "3. 【阶段二：P1 建议级（记录即可，不阻断交付）】多重极端巧合才会触发的边界假设、代码风格或锦上添花优化。",
          "4. 【结论】明确给出「通过」或「需修 P0 后再交」。",
          "不要修改任何文件。",
        ]
          .filter(Boolean)
          .join("\n");
        result = await runHeadlessCodex({
          account: toolArgs.account,
          prompt: reviewPrompt,
          topic: toolArgs.focus ? `两阶段审查: ${toolArgs.focus}` : "两阶段代码审查",
          working_dir: toolArgs.working_dir,
          sandbox: "read-only",
          tier: toolArgs.tier || (toolArgs.model ? null : "balanced"),
          model: toolArgs.model,
          reasoning_effort: toolArgs.reasoning_effort || "high",
          timeout_seconds: toolArgs.timeout_seconds,
        });
      } else if (toolName === "codex_generate_image") {
        result = await handleGenerateImage(toolArgs);
      } else if (toolName === "deepseek_ask") {
        result = await handleDeepSeekAsk(toolArgs);
      } else if (toolName === "deepseek_search") {
        result = await handleDeepSeekSearch(toolArgs);
      } else {
        sendJson({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unknown tool: ${toolName}` },
        });
        return;
      }

      sendJson({ jsonrpc: "2.0", id, result });
      return;
    }

    sendJson({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  } catch (err) {
    sendJson({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: err?.message || String(err) },
    });
  }
}

loadRegistrySync();

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  handleRequest(msg);
});
