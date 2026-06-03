import Anthropic from "@anthropic-ai/sdk";
import { tavilySearch } from "./tavily.js";
import { verifyReport } from "./verify.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";

export const SYSTEM_PROMPT = `你是一个自主研究 agent（autonomous research agent）。

你的工作流程：
1. 先把用户的问题拆解成若干个需要查证的子问题，并简要说明拆解思路（用文字输出，这会被记录到 trace 里）。
2. 然后进入多轮搜索：每一轮你都要调用 web_search 工具去检索信息。
   - 每次调用必须给出 query（要搜的检索词）和 reason（为什么现在要搜这个、它对应哪个子问题、你希望补上哪块信息）。
   - 每轮拿到结果后，根据已经掌握的信息判断下一步搜什么。如果某个方向信息不足或互相矛盾，就继续追问式搜索。
3. 当你判断信息已经足够回答问题时，停止调用工具，直接输出一份 Markdown 研究报告。

重要约束：
- 一次只发起一个 web_search 调用，便于逐轮追踪你的决策。
- 不要凭空编造事实。报告里的每个关键结论都要来自搜索结果。
- 报告必须是 Markdown 格式，包含：标题、执行摘要（要点）、分主题的详细分析、以及结尾的「来源」清单（编号 + 标题 + 完整 URL）。
- 正文中引用某条结论时，用 [n] 角标对应到来源清单。
- 如果搜索结果不足以支撑某个结论，明确说明信息缺口，不要硬编。
- 报告语言与用户提问语言保持一致。`;

const TOOLS = [
  {
    name: "web_search",
    description:
      "使用 Tavily 搜索引擎检索网络信息。返回若干条结果（标题、URL、摘要）以及一个可选的概要答案。用于查证子问题、补充事实、获取来源链接。",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "要检索的关键词或问题。应当具体、聚焦于一个信息点。",
        },
        reason: {
          type: "string",
          description:
            "为什么现在要搜这个：它对应哪个子问题、你想补上哪块信息、与已掌握信息的关系。",
        },
      },
      required: ["query", "reason"],
    },
  },
];

function truncate(str, n) {
  if (!str) return "";
  return str.length > n ? str.slice(0, n) + "…" : str;
}

function logTrace(round, { query, reason, result }, label = "") {
  const tag = label ? `[${label}] ` : "";
  const line = "─".repeat(72);
  console.error(`\n${line}`);
  console.error(`🔎 ${tag}第 ${round} 轮搜索`);
  console.error(line);
  console.error(`• 搜索词 (query):  ${query}`);
  console.error(`• 原因   (reason): ${reason}`);
  if (result.answer) {
    console.error(`• Tavily 概要:     ${truncate(result.answer, 300)}`);
  }
  console.error(`• 获得 ${result.results.length} 条结果:`);
  result.results.forEach((r, i) => {
    console.error(`    [${i + 1}] ${truncate(r.title, 90)}`);
    console.error(`        ${r.url}`);
    console.error(`        ${truncate(r.content, 160)}`);
  });
}

function logThinking(text, label = "") {
  const trimmed = text.trim();
  if (!trimmed) return;
  const tag = label ? `[${label}] ` : "";
  console.error(`\n💭 ${tag}Agent 思考 / 拆解:`);
  console.error(
    trimmed
      .split("\n")
      .map((l) => `   ${l}`)
      .join("\n")
  );
}

/**
 * Run a single autonomous tool-use search loop and return its draft.
 *
 * This is the shared engine used both by the default single-perspective
 * research flow and by each angle of the multi-perspective flow. It does NOT
 * run the verification (skeptic) pass; callers decide whether to verify.
 *
 * @param {object} opts
 * @param {string} opts.question         The research question.
 * @param {string} [opts.systemText]     System prompt (defaults to SYSTEM_PROMPT).
 * @param {string} [opts.userContent]    First user turn (defaults to a generic ask).
 * @param {string} [opts.label]          Short label for trace lines (e.g. a perspective name).
 * @returns {Promise<{draft: string, rounds: number, sources: Array<{title: string, url: string}>}>}
 */
export async function runSearchLoop(opts = {}) {
  const question = opts.question;
  const systemText = opts.systemText ?? SYSTEM_PROMPT;
  const label = opts.label ?? "";

  const apiKey = opts.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set.");
  }

  const model = opts.model ?? process.env.MODEL ?? DEFAULT_MODEL;
  const maxRounds = opts.maxRounds ?? Number(process.env.MAX_ROUNDS ?? 8);
  const searchDepth = opts.searchDepth ?? process.env.SEARCH_DEPTH ?? "advanced";
  const maxResults =
    opts.maxResults ?? Number(process.env.RESULTS_PER_SEARCH ?? 5);

  // Allow injecting a client / search fn for testing; default to the real ones.
  const client = opts.client ?? new Anthropic({ apiKey });
  const search = opts.search ?? tavilySearch;

  // Prompt caching: mark the system prompt + tools as cacheable so that the
  // (large, static) instructions are reused across the many turns of the loop.
  const system = [
    {
      type: "text",
      text: systemText,
      cache_control: { type: "ephemeral" },
    },
  ];
  const tools = TOOLS.map((t, i) =>
    i === TOOLS.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t
  );

  const messages = [
    {
      role: "user",
      content:
        opts.userContent ??
        `请研究以下问题，并产出带来源链接的 Markdown 报告：\n\n${question}`,
    },
  ];

  const sources = [];
  const seenUrls = new Set();
  let round = 0;
  const tag = label ? `[${label}] ` : "";

  while (true) {
    const response = await client.messages.create({
      model,
      max_tokens: 8000,
      system,
      tools,
      messages,
    });

    if (response.usage) {
      const u = response.usage;
      console.error(
        `\n📊 ${tag}token 用量: in=${u.input_tokens} out=${u.output_tokens}` +
          ` | cache_write=${u.cache_creation_input_tokens ?? 0}` +
          ` cache_read=${u.cache_read_input_tokens ?? 0}`
      );
    }

    // Surface any free-text reasoning (decomposition, intermediate thoughts).
    for (const block of response.content) {
      if (block.type === "text") logThinking(block.text, label);
    }

    if (response.stop_reason !== "tool_use") {
      // The agent decided it has enough information -> draft.
      const draft = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      console.error(
        `\n✅ ${tag}Agent 判断信息已充足，共进行了 ${round} 轮搜索，生成初稿。`
      );
      return { draft, rounds: round, sources };
    }

    // Record assistant turn (must be echoed back verbatim).
    messages.push({ role: "assistant", content: response.content });

    // Execute each requested tool call.
    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== "tool_use" || block.name !== "web_search") continue;

      round += 1;
      const { query, reason } = block.input;

      let result;
      try {
        result = await search(query, { searchDepth, maxResults });
      } catch (err) {
        console.error(`\n⚠️  ${tag}搜索失败: ${err.message}`);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          is_error: true,
          content: `搜索失败: ${err.message}`,
        });
        continue;
      }

      logTrace(round, { query, reason, result }, label);

      for (const r of result.results) {
        if (r.url && !seenUrls.has(r.url)) {
          seenUrls.add(r.url);
          sources.push({ title: r.title, url: r.url });
        }
      }

      const payload = {
        query,
        answer: result.answer,
        results: result.results.map((r) => ({
          title: r.title,
          url: r.url,
          content: r.content,
        })),
      };

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(payload),
      });

      if (round >= maxRounds) {
        console.error(
          `\n⏱️  ${tag}已达到最大轮数 (${maxRounds})，将提示 agent 基于现有信息收尾。`
        );
      }
    }

    if (round >= maxRounds) {
      // Keep roles alternating: append the wrap-up instruction as a text block
      // inside the same user turn that carries the tool results.
      toolResults.push({
        type: "text",
        text:
          "已达到最大搜索轮数。请不要再调用工具，基于目前掌握的信息直接输出最终的 Markdown 报告，并在信息不足处明确说明。",
      });
    }

    messages.push({ role: "user", content: toolResults });
  }
}

/**
 * Run the autonomous research agent (single perspective) + skeptic verification.
 *
 * @param {string} question
 * @param {object} [opts]
 * @returns {Promise<{report: string, rounds: number, sources: Array<{title: string, url: string}>, verifications: Array}>}
 */
export async function runResearch(question, opts = {}) {
  const apiKey = opts.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set.");
  }

  const model = opts.model ?? process.env.MODEL ?? DEFAULT_MODEL;
  const searchDepth = opts.searchDepth ?? process.env.SEARCH_DEPTH ?? "advanced";
  const maxResults =
    opts.maxResults ?? Number(process.env.RESULTS_PER_SEARCH ?? 5);
  const client = opts.client ?? new Anthropic({ apiKey });
  const search = opts.search ?? tavilySearch;
  // Verification (skeptic pass) is part of the research flow; only disabled
  // explicitly (e.g. for isolated tests of the search loop).
  const verify = opts.verify !== false;

  console.error(`\n🧭 研究问题: ${question}`);
  console.error(
    `🤖 模型: ${model} | 搜索深度: ${searchDepth} | 策略: 单视角`
  );

  const { draft, rounds, sources } = await runSearchLoop({
    ...opts,
    question,
    client,
    search,
    model,
    searchDepth,
    maxResults,
    anthropicApiKey: apiKey,
  });

  if (!verify) {
    return { report: draft, rounds, sources, verifications: [] };
  }

  // Mandatory skeptic pass: try to refute each core conclusion.
  const seenUrls = new Set(sources.map((s) => s.url));
  const {
    report: verifiedReport,
    verifications,
    extraSources,
  } = await verifyReport(draft, {
    client,
    search,
    model,
    searchDepth,
    maxResults,
    anthropicApiKey: apiKey,
  });

  for (const s of extraSources) {
    if (s.url && !seenUrls.has(s.url)) {
      seenUrls.add(s.url);
      sources.push(s);
    }
  }

  return { report: verifiedReport, rounds, sources, verifications };
}
