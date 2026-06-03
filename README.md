# auto-research-agent

一个能跑的自主研究 agent：**Node.js + [@anthropic-ai/sdk](https://www.npmjs.com/package/@anthropic-ai/sdk)（claude-sonnet-4-6，开启 prompt caching）+ [Tavily Search API](https://tavily.com/)**。

给它一个问题，它会：

1. **自主拆解子问题** —— 先把问题分解成需要查证的几个方面；
2. **多轮搜索** —— 每一轮根据已掌握的信息决定下一步搜什么，并自行判断何时信息已经充足；
3. **输出 Markdown 报告** —— 含执行摘要、分主题分析，以及结尾带完整 URL 的「来源」清单（正文用 `[n]` 角标引用）。

每一轮决策都会打印 **trace**：搜了什么词（query）、为什么搜（reason）、获得了什么（结果标题 + URL + 摘要）。

## 工作原理

整个流程是一个基于 Anthropic **tool-use 循环**的 agent：

- 模型可以反复调用 `web_search(query, reason)` 工具；每次调用都必须给出检索词和理由，工具用 Tavily 实际检索并把结果回传给模型。
- 模型自己决定还要不要继续搜；当它判断信息足够时，就停止调用工具、直接输出最终报告。
- system prompt 和工具定义通过 `cache_control: { type: "ephemeral" }` 开启 **prompt caching**，在多轮循环中复用这部分静态上下文以省 token。
- 有 `MAX_ROUNDS` 兜底，达到上限会提示 agent 基于现有信息收尾，避免无限循环。

## 快速开始

```bash
npm install
cp .env.example .env   # 填入 ANTHROPIC_API_KEY 和 TAVILY_API_KEY
node run.js "你的问题"
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
| `MAX_ROUNDS` | 否 | `8` | 最大搜索轮数（兜底） |
| `SEARCH_DEPTH` | 否 | `advanced` | Tavily 搜索深度：`basic` / `advanced` |
| `RESULTS_PER_SEARCH` | 否 | `5` | 每次搜索返回的结果数 |

## 文件结构

```
run.js          # 入口：读取问题、运行、输出报告（+保存到 reports/）
src/agent.js    # 研究 agent：tool-use 循环、prompt caching、trace 打印
src/tavily.js   # Tavily Search API 客户端
```
