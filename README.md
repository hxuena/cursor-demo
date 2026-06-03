# auto-research-agent

一个能跑的自主研究 agent：**Node.js + [@anthropic-ai/sdk](https://www.npmjs.com/package/@anthropic-ai/sdk)（claude-sonnet-4-6，开启 prompt caching）+ [Tavily Search API](https://tavily.com/)**。

给它一个问题，它会：

1. **多视角并行搜索（默认）** —— 同一个问题，**同时**从三个不同角度各派一个 agent 检索：**支持方视角**、**反对方视角**、**学术/数据视角**。三路检索的结果合并去重后，再交给一个综合 agent 整合成一份平衡的报告（其中专设「多视角交叉对照」小节，标注各视角的一致点与分歧点）。也可以用 `--single` 退回到传统的单视角自主搜索。
2. **每个视角内部多轮搜索** —— 每个视角都是一个独立的 agent，根据已掌握的信息决定下一步搜什么，并自行判断何时信息已经充足；
3. **综合报告** —— 含执行摘要、分主题分析、「多视角交叉对照」，以及结尾带完整 URL 的「来源」清单（正文用 `[n]` 角标引用）；
4. **结论核查（Verification）** —— 综合报告生成后自动进入核查阶段：先从报告提炼出核心结论，再为**每个结论各派一个 skeptic（红队）**，提示它专门去搜索反面/矛盾证据尝试反驳。最终报告追加「结论核查」一节，每条结论标注 `[verified]` / `[disputed]`，`[disputed]` 的附上检索到的反面证据（要点 + URL）。这一步是研究流程的固定环节，不是可选项。

每一路视角的每一轮决策都会打印 **trace**（带视角标签）：搜了什么词（query）、为什么搜（reason）、获得了什么（结果标题 + URL + 摘要）。核查阶段每个 skeptic 的反向检索同样会打印 trace。

## 单视角 vs 多视角

| | 单视角（`--single`） | 多视角（默认 / `--multi`） |
| --- | --- | --- |
| 检索角度 | 一个中立 agent 自主决定 | 支持方 / 反对方 / 学术数据 三路并行 |
| 覆盖广度 | 取决于单个 agent 的视野，易有盲区 | 强制覆盖正反两面 + 实证视角 |
| 中立性 | 可能被首批检索结果带偏 | 综合阶段明确并列正反论据、标注分歧 |
| 成本 | 较低 | 约 3 倍检索 + 一次综合调用 |

用 `--compare` 可以对**同一个问题**分别跑单视角与多视角，并额外生成一份「单视角 vs 多视角 · 报告差异对比」。

## 工作原理

### 多视角检索（默认）

`src/perspectives.js` 实现「同一问题、多角度并行」的搜索策略：

- **三个视角**（见 `PERSPECTIVES`）各自是一个独立的 tool-use agent，共用 `src/agent.js` 里的 `runSearchLoop`，但带上不同的视角 system prompt：
  - ✅ **支持方视角**：检索支持论据、正面案例、收益、成功经验；
  - ⛔ **反对方视角**：检索风险、缺陷、失败案例、批评与反驳证据；
  - 📊 **学术/数据视角**：检索论文、统计数据、权威机构报告、量化证据。
- 三路 agent 用 `Promise.all` **并行**运行，各自产出一份「发现摘要」；
- **合并去重**：把三路检索到的来源按 URL 去重，得到一份统一来源清单；
- **综合**：一个综合 agent 拿到三份发现摘要 + 统一来源清单，整合成一份平衡报告，并在「多视角交叉对照」小节明确写出各视角的一致点与分歧点（引用统一编号 `[n]`）；
- 之后照常进入下面的**结论核查**子流程。

单视角模式（`--single`）则跳过上述分角度步骤，直接用单个 `runSearchLoop` 产出初稿。

### tool-use 循环（每个 agent 内部）

整个流程是一个基于 Anthropic **tool-use 循环**的 agent：

- 模型可以反复调用 `web_search(query, reason)` 工具；每次调用都必须给出检索词和理由，工具用 Tavily 实际检索并把结果回传给模型。
- 模型自己决定还要不要继续搜；当它判断信息足够时，就停止调用工具、先输出报告初稿。
- system prompt 和工具定义通过 `cache_control: { type: "ephemeral" }` 开启 **prompt caching**，在多轮循环中复用这部分静态上下文以省 token。
- 有 `MAX_ROUNDS` 兜底，达到上限会提示 agent 基于现有信息收尾，避免无限循环。

初稿完成后进入 **核查（verification）子流程**（`src/verify.js`）：

- **提炼结论**：用一次结构化调用（`submit_conclusions` 工具）从初稿中抽取若干条可检验的核心结论。
- **逐条派 skeptic**：对每条结论 spawn 一个独立的 skeptic 对话（默认并发 `SKEPTIC_CONCURRENCY` 条）。skeptic 的 system prompt 要求它**只找反面证据**，通过 `web_search` 反向检索，最后调用 `submit_verdict` 给出裁决。
- **裁决与标注**：`verified` 表示尽力搜索仍找不到有力反面证据；`disputed` 表示找到了可信的矛盾证据，且**必须**附带反面证据（要点 + URL）——没有证据的 `disputed` 会被降级为 `verified`，确保「disputed 必带反面证据」。
- **合并来源**：反面证据的 URL 会并入报告整体的来源集合。

## 快速开始

```bash
npm install
cp .env.example .env   # 填入 ANTHROPIC_API_KEY 和 TAVILY_API_KEY
node run.js "你的问题"            # 默认：多视角
```

模式选择：

```bash
node run.js --multi   "全民基本收入是否可行？"   # 多视角（默认，可省略 --multi）
node run.js --single  "全民基本收入是否可行？"   # 单视角（传统行为）
node run.js --compare "全民基本收入是否可行？"   # 两种都跑，并输出差异对比
```

例如：

```bash
node run.js "2024 年以来固态电池在量产车上的进展如何？"
```

## 输出说明

- **trace / 进度** 打印到 **stderr**（思考、每轮搜索、token 用量、收尾信息）。
- **最终 Markdown 报告** 打印到 **stdout**，因此可以直接重定向保存：

```bash
node run.js "你的问题" > report.md
```

每次运行也会在 `reports/` 目录下自动存一份报告副本。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | 是 | — | Anthropic API key |
| `TAVILY_API_KEY` | 是 | — | Tavily Search API key |
| `MODEL` | 否 | `claude-sonnet-4-6` | 使用的 Claude 模型 |
| `MAX_ROUNDS` | 否 | `8` | 单视角模式最大搜索轮数（兜底） |
| `PERSPECTIVE_MAX_ROUNDS` | 否 | `5` | 多视角模式下每个视角的最大搜索轮数（兜底） |
| `SEARCH_DEPTH` | 否 | `advanced` | Tavily 搜索深度：`basic` / `advanced` |
| `RESULTS_PER_SEARCH` | 否 | `5` | 每次搜索返回的结果数 |
| `SKEPTIC_MAX_ROUNDS` | 否 | `4` | 单个 skeptic 反向检索的最大轮数（兜底） |
| `SKEPTIC_CONCURRENCY` | 否 | `3` | 同时运行的 skeptic 数量 |

## 文件结构

```
run.js               # 入口：解析 --single/--multi/--compare，运行并输出报告（+保存到 reports/）
src/agent.js         # 共享搜索引擎 runSearchLoop（tool-use 循环、prompt caching、trace）+ 单视角 runResearch
src/perspectives.js  # 多视角策略：三角度并行检索、合并去重、综合成平衡报告
src/compare.js       # 单视角 vs 多视角：分别运行并生成报告差异对比
src/verify.js        # 结论核查：提炼结论、逐条 spawn skeptic 反驳、产出 [verified]/[disputed] 标注
src/tavily.js        # Tavily Search API 客户端
```
