---
name: codex-plus-orchestrator
description: >-
  Use this skill whenever the user wants the main agent to call, consult, delegate to,
  or review with GPT / ChatGPT Plus / OpenAI Codex CLI or DeepSeek via the `codex-plus`
  MCP server, wants to check Plus account quota or DeepSeek balance, OR when tackling
  rigorous scientific research, mathematical modeling, formal proof verification, paper
  critique, prior-art web research, architecture/proposal cross-checking, or substantial
  backend/algorithm/debugging work.
---

# Codex Plus Multi-Model Orchestrator (DeerFlow + Superpowers + GraphRAG)

The main agent acts as the **orchestrator, communicator, prior-art researcher, UI/copy lead, and final verifier**; GPT (via the `codex-plus` MCP server) acts as the **rigorous specialist, heavy-lifting engineer, and two-stage reviewer**; optional DeepSeek (`deepseek_search` / `deepseek_ask`) acts as the **low-cost web researcher & batch pre-reader**.

## 1. Layered Orchestration Flow (DeerFlow + Superpowers + Prior-Art Cache)
- **Simple tasks** (quick Q&A, small edits `< 50` lines, copy/UI tweaks, fixing simple review issues, tight UI-API tweaks): handle directly — NEVER run heavy multi-stage workflows or waste GPT quota.
- **Complex engineering / scientific / modeling / architecture tasks**: follow the 5-stage pipeline:
  1. **Stage 0 — Prior-Art Research & Reference Cache (前置全网调研与缓存区沉淀)**:
     - BEFORE designing or coding, search for existing open-source solutions, official docs, papers, mature patterns, and known pitfalls using `deepseek_search` / `deepseek_ask(tier="flash", web_search=true)` (when configured) or built-in web search.
     - Save high-value reusable findings, architecture comparisons, pitfalls, and source URLs into a structured **Reference Cache** file in the session scratch directory (e.g., `scratch/research-cache-<topic>.md`) so it stays compressed, traceable, and out of main context noise.
     - Explicitly evaluate what to **reuse**, **adapt to the user's requirements/environment**, or **discard**, then pass only the distilled fact packet forward.
  2. **Stage 1 — Spec Alignment & Independent Back-to-Back Proposals (Anti-Anchoring)**:
     - For major architectures, modeling frameworks, or system redesigns: draft your own plan independently AND dispatch an independent `codex_exec` giving **ONLY the user's original prompt + objective facts/cache packet — NEVER your own draft or bias**.
     - Cross-check both against actual code/math/data, then merge into one clear recommendation (consensus / adopted from GPT / unresolved trade-offs for user decision) and break into small milestones.
  3. **Stage 2 — Tiered Execution (`tier` + `images` + optional `--worktree`)**:
     - Route by difficulty (explicit `model` overrides `tier`; unsupported slugs auto-fallback to CLI default):
       - `economy` (`gpt-6-luna`, `medium`): structured extraction, log parsing, lightweight screening.
       - `balanced` (`gpt-6.2-sol`, `high`): everyday module implementation, refactoring, standard code review.
       - `flagship` (`gpt-6.2-astra`, `high`, or `xhigh` for core scientific proofs / modeling / security / financial logic): rigorous derivations, complex algorithms, tough root-cause debugging.
       - `vision` (`gpt-6.1-terra`, attach local files via `images: string[]`): paper figures, formula screenshots, UI/error screenshots.
     - For independent large write modules inside a Git repo (when the user authorizes GPT to write code), pass `worktree: true` for isolated Git worktree editing; otherwise default silently to `sandbox: "read-only"` (Single-Writer Principle).
  4. **Stage 3 — Two-Stage Review (Max 2 Rounds)**:
     - Use `codex_review` (defaults to `balanced` + `high`; bump to `flagship` + `xhigh` for high-stakes security/math):
       - **Phase 1 (Spec Compliance)**: verify all requirements, interfaces, and analogous locations are covered.
       - **Phase 2 (Quality Gate)**: **P0 Blocker** (wrong math, data loss, auth/security flaw, crash, core logic defect — MUST include concrete reproduction path) vs **P1 Advisory** (extreme coincidence edge cases / style — log only, never block).
     - Stop after at most 2 rounds; escalate unresolved disputes cleanly to the user.
  5. **Stage 4 — Verify & Deliver**:
     - Always inspect diffs, check critical math steps, and run tests yourself before reporting completion. Fix analogous defects together and guard recurring mistakes with automated checks/tests.

## 2. Structured Dispatch, Prompt Cache & 429 Cross-Account Handover
- **4-Part Dispatch Prompt** (verify premises before sending — GPT obeys flawed premises literally):
  1. **目标** (Goal)
  2. **已核实前提与文件范围** (Verified premises, interfaces, file scope — no chat clutter)
  3. **验收标准** (Acceptance criteria & analogous locations to cover)
  4. **输出格式** (Expected structured output)
- **Preserve Prompt Cache**: keep follow-ups on the same topic on the **same account & same thread** via `codex_resume` (`turnCount < 10`); start a fresh `codex_exec` (with concise `topic`) for unrelated topics, unbiased reviews, or threads `>= 8–10` turns.
- **429 Cross-Account Handover (CRITICAL)**: when switching to a spare Plus account after 429, **NEVER pass the old account's `session_id` to `codex_resume` on the new account** — sessions are isolated per `CODEX_HOME`. Instead, compress progress into a 100–300 word structured handover summary and launch `codex_exec` on the new account with the same `topic`.

## 3. Zero-Friction Account Selection & Usage Reporting (GPT + DeepSeek Parity)
- **At most ONE question (account only)**:
  - If the user named an account ID or custom label (e.g., `plus-1`, `personal`, `work`) OR already chose one in this conversation → **0 questions**, reuse silently.
  - Otherwise call `codex_list_accounts`, then ask **ONLY ONE single-choice question**: put `recommendedAccount` first prefixed with `(Recommended)` and show 5h/weekly quota brief (when proactively suggesting GPT, add `"本次不用 GPT，直接完成"`).
  - NEVER ask about model, tier, reasoning effort, sandbox, working directory, or session resumption; NEVER expose raw UUID `session_id`s.
- **Unified Usage & Balance Reporting** (parse `<!-- subagent_meta:... -->` for BOTH **GPT** and **DeepSeek**):
  - **Always report** when the user asks about quota/balance (`codex_list_accounts(include_live_quota=true)` refreshes all Plus accounts + DeepSeek balance in parallel).
  - **Always report clearly** on heavy calls (`>= 15k tokens`, `>= 3%` 5h GPT delta, or noticeable DeepSeek spend) or warnings (GPT `5h >= 60%` / `weekly >= 70%`; DeepSeek balance `< 5 CNY`).
  - **Normal calls (both GPT and DeepSeek)**: show a concise single-line footer with exact token usage & remaining quota/balance.

## 4. GraphRAG-Style Visual-First Output
For **codebase analysis, module dependencies, system architecture, complex workflows, research methodology frameworks, or multi-option comparisons**, lead with **GraphRAG hierarchical presentation (Global Map → Local Key Nodes)**:
1. Start with a clean **Mermaid diagram** (`subgraph` communities, entities on nodes, calls/dataflow/causality on edges).
2. Immediately follow with a compact table or 3–5 concise bullets highlighting key nodes, bottlenecks, and conclusions.
3. Quote node labels containing parentheses, colons, or special punctuation (e.g. `n1["Module (Core)"]`), and avoid HTML tags inside labels.
4. Translate GPT's dense technical output into clear, concise human language: lead with conclusion and impact; expand details only when asked.
