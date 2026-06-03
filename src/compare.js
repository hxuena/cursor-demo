import Anthropic from "@anthropic-ai/sdk";
import { runResearch } from "./agent.js";
import { runMultiPerspectiveResearch } from "./perspectives.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";

const COMPARER_SYSTEM = `你是一个研究方法分析师。给你针对**同一个问题**生成的两份研究报告：
- 报告 A 来自「单视角」策略（一个中立 agent 自主搜索）。
- 报告 B 来自「多视角」策略（支持方 / 反对方 / 学术数据三个角度并行搜索后再综合）。

你的任务是写一份简洁、客观的 Markdown 对比，分析两者差异，而不是重述报告内容。请覆盖：
1. **覆盖广度**：哪一份覆盖了更多角度 / 子议题？另一份漏掉了什么？
2. **平衡性与中立度**：是否充分呈现了正反两方？有没有明显倾向？
3. **结论差异**：两份报告的核心结论在哪些地方一致、在哪些地方不同甚至相反？
4. **来源多样性**：来源的数量与多样性差异（如是否引入了批评方 / 学术来源）。
5. **取舍**：多视角是否带来额外价值？是否也有代价（成本、冗余、噪音）？

输出格式：以「## 单视角 vs 多视角 · 报告差异对比」为标题的一节，使用要点和必要的小标题。保持克制，只讲有依据的差异。语言与问题保持一致。`;

/**
 * Produce a comparison section contrasting a single-perspective report with a
 * multi-perspective report on the same question. One LLM call, no tools.
 */
export async function compareReports(question, singleReport, multiReport, opts = {}) {
  const apiKey = opts.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  const client = opts.client ?? new Anthropic({ apiKey });
  const model = opts.model ?? process.env.MODEL ?? DEFAULT_MODEL;

  const userContent =
    `问题：\n${question}\n\n` +
    `===== 报告 A（单视角） =====\n${singleReport}\n\n` +
    `===== 报告 B（多视角） =====\n${multiReport}\n\n` +
    `请按系统提示的要求，输出两份报告的差异对比。`;

  const response = await client.messages.create({
    model,
    max_tokens: 4000,
    system: COMPARER_SYSTEM,
    messages: [{ role: "user", content: userContent }],
  });

  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Run both strategies on the same question and produce a comparison.
 *
 * Single- and multi-perspective runs are launched in parallel; once both
 * finish, a comparison section is generated.
 *
 * @returns {Promise<{single: object, multi: object, comparison: string}>}
 */
export async function compareStrategies(question, opts = {}) {
  console.error(`\n${"#".repeat(72)}`);
  console.error("⚖️  对比模式：同一问题分别用「单视角」与「多视角」策略各跑一遍。");
  console.error("#".repeat(72));

  const [single, multi] = await Promise.all([
    runResearch(question, opts),
    runMultiPerspectiveResearch(question, opts),
  ]);

  console.error(`\n${"═".repeat(72)}`);
  console.error("🧮 两份报告均已生成，开始分析差异…");

  const comparison = await compareReports(
    question,
    single.report,
    multi.report,
    opts
  );

  return { single, multi, comparison };
}
