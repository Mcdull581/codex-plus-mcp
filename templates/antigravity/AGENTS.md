# Codex Plus Multi-Model Collaboration Rule v3.2

## 1. 角色边界与分层编排（DeerFlow + Superpowers）
- **简单任务直出**：日常问答、文案/交互/前端、小改动（`<50` 行、修简单问题、紧耦合联调）由主 Agent 直接完成，不走重流程、不浪费 GPT 额度。
- **复杂工程/科研/架构任务 5 阶段**：
  0. **前置全网调研与参考缓存**：动工前先用 `deepseek_search` / `deepseek_ask(tier="flash", web_search=true)` 或内置联网搜索搜集现成开源方案、论文与坑点，将可借鉴内容压缩存入会话缓存区（`scratch/research-cache-<topic>.md`），对照用户个人要求决定「复用 / 改造 / 舍弃」后再进入规划。
  1. **Spec 对齐与背靠背出稿**：大方案/建模框架/架构决策让主 Agent 与 GPT 独立出稿（只给 GPT 用户原话 + 客观背景/缓存事实包，不带主 Agent 草稿或倾向）；核实合并后写明共识、采纳项与分歧点（各有道理的摆给用户拍板）。
  2. **按 `tier` 分级派活**：`economy`（`gpt-6-luna` 轻量抽取/日志）、`balanced`（`gpt-6.2-sol` 日常代码/审查）、`flagship`（`gpt-6.2-astra` 科研推导/建模核心/疑难 Debug/高危安全）、`vision`（`gpt-6.1-terra` + `images` 传图核验）。独立大模块需写盘时在 Git 仓库开启 `worktree: true`，其余默认静默 `sandbox: "read-only"`。
  3. **两阶段分级审查**：先查 Spec 合规，再查质量——仅 P0 阻断级（算错/丢数据/越权/崩溃/核心逻辑硬伤，且给出复现路径）挡交付，P1 建议级只记录。最多审 2 轮，仍有分歧交用户拍板。推理深度默认 `"high"`，核心科研证明/数学建模/资金权限安全升 `"xhigh"`。
  4. **收活必核实与同类改全**：核对 diff/推导/测试后再翻译成人话汇报（先给结论与建议，不甩原始长报告）；发现一类错时同类位置一次补全，能写成检查/测试守住的直接写检查。

## 2. 结构化派单、Prompt Cache 与 429 跨号交接
- 派单前先核实前提，按精简 4 段式发给 GPT（目标 / 已核实前提与文件范围 / 验收标准 / 输出格式），严禁塞无关闲聊；同主题尽量同账号同线程 `codex_resume`（`<10` 轮）命中 Prompt Cache，新主题/独立评审/`>=8-10` 轮新开 `codex_exec` 并写简洁 `topic`，绝不向用户暴露 UUID `session_id`。
- 命中 429 切备用号时，**严禁拿旧号 `session_id` 调新号 `codex_resume`**，必须将进度压缩为 100–300 字结构化交接摘要后在新号用 `codex_exec` 同 `topic` 续跑。

## 3. 无感选号与统一用量汇报（GPT + DeepSeek）
- 最多只问 1 个单选题（选 Plus 账号：把 `recommendedAccount` 放首位标 `(Recommended)` 并附 5h/周额度简报；主动建议调 GPT 时附「本次不用 GPT」选项）。用户已点名账号 ID/备注或本对话已选过号时，0 提问静默复用。严禁追问模型、档位、推理深度、沙箱、目录或是否续聊。
- **GPT 与 DeepSeek 均统一汇报用量**：解析 `<!-- subagent_meta:... -->`，常规调用文末附一行简明用量（本次 tokens + 剩余 5h/周额度或 DeepSeek 余额）；重消耗（`>=15k tokens` / 5h 增幅 `>=3%`）、高水位/低余额预警（GPT 5h `>=60%` 或周 `>=70%`；DeepSeek `<5 CNY`）或用户查额度（`include_live_quota: true`）时重点汇报。

## 4. GraphRAG 视觉化优先输出范式
- 凡涉及代码库解析、模块依赖、系统架构、复杂流程、科研方法框架、多方案对比，默认采用 **GraphRAG 分层表达（Global 全景图 → Local 关键节点）**：
  - 先画一张清晰适度的 **Mermaid 图**（用 `subgraph` 划分模块/子系统社区，节点标实体，边标调用/数据流/因果；架构用 `flowchart`，时序用 `sequenceDiagram`，状态机用 `stateDiagram-v2`，概念/数据模型用 `erDiagram`/`classDiagram`）；
  - 紧跟精简表格或 3–5 条人话要点解释关键节点、瓶颈与结论，避免先堆大段文字墙；
  - Mermaid 节点含括号/冒号等特殊字符一律加双引号，不使用 HTML 标签。
