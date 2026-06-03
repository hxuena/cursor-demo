import Anthropic from "@anthropic-ai/sdk";
import { tavilySearch } from "./tavily.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";

// ── Tool definitions ────────────────────────────────────────────────────────

// Reused by the skeptic loop. Kept independent from agent.js to avoid a
// circular import (agent.js depends on this module).
const WEB_SEARCH_TOOL = {
  name: "web_search",
  description:
    "使用 Tavily 搜索引擎检索网络信息。返回若干条结果（标题、URL、摘要）。用于寻找与待核查结论相矛盾、相反、质疑或反驳的证据。",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "要检索的关键词或问题。应当具体、聚焦，并刻意指向反面证据。",
      },
      reason: {
        type: "string",
        description: "为什么搜这个：你想找哪一类反面/矛盾证据来挑战该结论。",
      },
    },
    required: ["query", "reason"],
  },
};

const SUBMIT_VERDICT_TOOL = {
  name: "submit_verdict",
  description:
    "在你完成对该结论的反向检索后，提交最终裁决。verified 表示尽力搜索后仍找不到有力反面证据、结论站得住；disputed 表示找到了可信的反面或矛盾证据。disputed 时必须在 counter_evidence 中列出反面证据。",
  input_schema: {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        enum: ["verified", "disputed"],
        description: "verified（结论站得住）或 disputed（存在可信的反面证据）。",
      },
      reasoning: {
        type: "string",
        description: "一句话说明裁决依据：为什么结论站得住，或反面证据为何可信。",
      },
      counter_evidence: {
        type: "array",
        description:
          "反面证据清单。disputed 时必填，至少一条；verified 时留空数组。",
        items: {
          type: "object",
          properties: {
            point: { type: "string", description: "这条反面证据具体说明了什么。" },
            url: { type: "string", description: "证据来源的完整 URL。" },
          },
          required: ["point", "url"],
        },
      },
    },
    required: ["verdict", "reasoning"],
  },
};

const SUBMIT_CONCLUSIONS_TOOL = {
  name: "submit_conclusions",
  description:
    "提交从研究报告中提炼出的核心结论清单。每条结论应是一个独立、可被检验的事实性论断，用简洁完整的句子表述（不含 [n] 角标）。",
  input_schema: {
    type: "object",
    properties: {
      conclusions: {
        type: "array",
        description: "核心结论清单，按重要性排序，一般 3-7 条。",
        items: { type: "string" },
      },
    },
    required: ["conclusions"],
  },
};

// ── Prompts ──────────────────────────────────────────────────────────────────

const EXTRACTOR_SYSTEM = `你是一个分析助手。给你一份研究报告，你要从中提炼出它所主张的「核心结论」——也就是这份报告希望读者相信、且可以被事实检验的关键论断。

要求：
- 每条结论是一个独立、自洽、可检验的事实性陈述，去掉 [n] 角标和模糊措辞。
- 只提取真正的核心论断（一般 3-7 条），不要把背景介绍、定义、免责声明当作结论。
- 用与报告相同的语言表述。
- 通过调用 submit_conclusions 工具返回结果。`;

const SKEPTIC_SYSTEM = `你是一个怀疑论审稿人（skeptic / red-team reviewer）。给你一个来自研究报告的结论，你的唯一任务是**尝试反驳它**。

工作方式：
1. 主动调用 web_search 去寻找与该结论**矛盾、相反、质疑、反驳或给出重要反例/限定条件**的证据。不要去找支持它的证据。
2. 多角度检索：换不同措辞、找批评意见、找更新的数据、找相反的统计口径、找权威机构的不同说法。
3. 当你检索充分后，调用 submit_verdict 给出裁决：
   - 如果尽力搜索后仍找不到有力的反面证据，说明结论站得住，裁决 verified。
   - 如果找到了可信的反面或矛盾证据，裁决 disputed，并在 counter_evidence 中列出这些反面证据（每条含要点说明 + 完整 URL）。

约束：
- 一次只发起一个 web_search 调用。
- 不要凭空编造反面证据；反面证据必须来自真实搜索结果，并附带其 URL。
- 保持严格但公正：证据不足以推翻结论时，不要勉强判为 disputed。`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function truncate(str, n) {
  if (!str) return "";
  return str.length > n ? str.slice(0, n) + "…" : str;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ── Step 1: extract core conclusions from the draft report ────────────────────

export async function extractConclusions(report, opts = {}) {
  const apiKey = opts.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  const client = opts.client ?? new Anthropic({ apiKey });
  const model = opts.model ?? process.env.MODEL ?? DEFAULT_MODEL;

  const response = await client.messages.create({
    model,
    max_tokens: 2000,
    system: EXTRACTOR_SYSTEM,
    tools: [SUBMIT_CONCLUSIONS_TOOL],
    tool_choice: { type: "tool", name: "submit_conclusions" },
    messages: [
      {
        role: "user",
        content: `请从下面这份研究报告中提炼核心结论：\n\n${report}`,
      },
    ],
  });

  const block = response.content.find(
    (b) => b.type === "tool_use" && b.name === "submit_conclusions"
  );
  const list = block?.input?.conclusions;
  if (!Array.isArray(list)) return [];
  return list
    .map((c) => (typeof c === "string" ? c.trim() : ""))
    .filter(Boolean);
}

// ── Step 2: spawn a skeptic to try to refute one conclusion ───────────────────

export async function verifyConclusion(conclusion, opts = {}) {
  const apiKey = opts.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  const client = opts.client ?? new Anthropic({ apiKey });
  const search = opts.search ?? tavilySearch;
  const model = opts.model ?? process.env.MODEL ?? DEFAULT_MODEL;
  const searchDepth = opts.searchDepth ?? process.env.SEARCH_DEPTH ?? "advanced";
  const maxResults =
    opts.maxResults ?? Number(process.env.RESULTS_PER_SEARCH ?? 5);
  const maxRounds = opts.maxRounds ?? Number(process.env.SKEPTIC_MAX_ROUNDS ?? 4);
  const onTrace = opts.onTrace ?? (() => {});

  const tools = [WEB_SEARCH_TOOL, SUBMIT_VERDICT_TOOL];
  const messages = [
    {
      role: "user",
      content: `待核查的结论：\n\n「${conclusion}」\n\n请尝试反驳它，并在检索充分后调用 submit_verdict。`,
    },
  ];

  let rounds = 0;
  const sources = [];

  while (true) {
    const response = await client.messages.create({
      model,
      max_tokens: 4000,
      system: SKEPTIC_SYSTEM,
      tools,
      messages,
    });

    const verdictBlock = response.content.find(
      (b) => b.type === "tool_use" && b.name === "submit_verdict"
    );
    if (verdictBlock) {
      const input = verdictBlock.input ?? {};
      const verdict = input.verdict === "disputed" ? "disputed" : "verified";
      const counterEvidence = Array.isArray(input.counter_evidence)
        ? input.counter_evidence
            .filter((e) => e && e.url)
            .map((e) => ({ point: e.point ?? "", url: e.url }))
        : [];
      // A disputed verdict without any evidence is downgraded to verified to
      // keep the rule "disputed must carry counter-evidence" honest.
      const finalVerdict =
        verdict === "disputed" && counterEvidence.length === 0
          ? "verified"
          : verdict;
      return {
        conclusion,
        verdict: finalVerdict,
        reasoning: input.reasoning ?? "",
        counterEvidence: finalVerdict === "disputed" ? counterEvidence : [],
        rounds,
        sources,
      };
    }

    if (response.stop_reason !== "tool_use") {
      // Skeptic stopped without a structured verdict: treat as verified.
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return {
        conclusion,
        verdict: "verified",
        reasoning: text || "未发现有力的反面证据。",
        counterEvidence: [],
        rounds,
        sources,
      };
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== "tool_use" || block.name !== "web_search") continue;
      rounds += 1;
      const { query, reason } = block.input;

      let result;
      try {
        result = await search(query, { searchDepth, maxResults });
      } catch (err) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          is_error: true,
          content: `搜索失败: ${err.message}`,
        });
        continue;
      }

      onTrace({ conclusion, round: rounds, query, reason, result });

      for (const r of result.results) {
        if (r.url) sources.push({ title: r.title, url: r.url });
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify({
          query,
          answer: result.answer,
          results: result.results.map((r) => ({
            title: r.title,
            url: r.url,
            content: r.content,
          })),
        }),
      });
    }

    if (rounds >= maxRounds) {
      toolResults.push({
        type: "text",
        text:
          "已达到最大反向检索轮数。请不要再调用 web_search，立即根据已掌握的信息调用 submit_verdict 给出裁决。",
      });
    }

    messages.push({ role: "user", content: toolResults });
  }
}

// ── Step 3: orchestrate verification of the whole report ──────────────────────

function logSkepticTrace({ conclusion, round, query, reason, result }) {
  const line = "·".repeat(72);
  console.error(`\n${line}`);
  console.error(`🕵️  反向核查 · 第 ${round} 轮`);
  console.error(`• 结论: ${truncate(conclusion, 90)}`);
  console.error(`• 搜索词 (query):  ${query}`);
  console.error(`• 原因   (reason): ${reason}`);
  console.error(`• 获得 ${result.results.length} 条结果:`);
  result.results.forEach((r, i) => {
    console.error(`    [${i + 1}] ${truncate(r.title, 90)}`);
    console.error(`        ${r.url}`);
  });
}

function buildVerificationSection(verifications) {
  const verifiedCount = verifications.filter(
    (v) => v.verdict === "verified"
  ).length;
  const disputedCount = verifications.length - verifiedCount;

  const lines = [];
  lines.push("## 结论核查（Verification）");
  lines.push("");
  lines.push(
    `> 报告生成后，对每个核心结论各派出一个 skeptic（红队）尝试反驳：` +
      `共 ${verifications.length} 条结论，**${verifiedCount} 条 [verified]、${disputedCount} 条 [disputed]**。` +
      `[disputed] 的结论附有检索到的反面证据，请谨慎对待。`
  );
  lines.push("");

  verifications.forEach((v, i) => {
    const tag = v.verdict === "disputed" ? "[disputed]" : "[verified]";
    lines.push(`${i + 1}. ${tag} ${v.conclusion}`);
    if (v.reasoning) {
      lines.push(`   - 核查说明：${v.reasoning}`);
    }
    if (v.verdict === "disputed" && v.counterEvidence.length > 0) {
      lines.push(`   - 反面证据：`);
      v.counterEvidence.forEach((e) => {
        const point = e.point ? `${e.point} ` : "";
        lines.push(`     - ${point}（${e.url}）`);
      });
    }
    lines.push("");
  });

  return lines.join("\n").trimEnd();
}

/**
 * Verify a draft report: extract its core conclusions, spawn a skeptic per
 * conclusion to hunt for counter-evidence, and append a labeled verification
 * section. This is a mandatory part of the research flow, not an option.
 *
 * @returns {Promise<{report: string, verifications: Array, extraSources: Array}>}
 */
export async function verifyReport(report, opts = {}) {
  const concurrency = opts.concurrency ?? Number(process.env.SKEPTIC_CONCURRENCY ?? 3);

  console.error(`\n${"═".repeat(72)}`);
  console.error("🔬 进入结论核查阶段：提炼核心结论并逐条派 skeptic 反驳…");

  const conclusions = await extractConclusions(report, opts);

  if (conclusions.length === 0) {
    console.error("⚠️  未能从报告中提炼出可核查的结论，跳过核查阶段。");
    return { report, verifications: [], extraSources: [] };
  }

  console.error(`📌 提炼出 ${conclusions.length} 条核心结论：`);
  conclusions.forEach((c, i) => console.error(`   ${i + 1}. ${truncate(c, 100)}`));

  const verifications = await mapWithConcurrency(
    conclusions,
    concurrency,
    (conclusion) =>
      verifyConclusion(conclusion, { ...opts, onTrace: logSkepticTrace })
  );

  const extraSources = [];
  const seen = new Set();
  for (const v of verifications) {
    for (const e of v.counterEvidence) {
      if (e.url && !seen.has(e.url)) {
        seen.add(e.url);
        extraSources.push({ title: e.point || e.url, url: e.url });
      }
    }
  }

  verifications.forEach((v) => {
    const tag = v.verdict === "disputed" ? "[disputed]" : "[verified]";
    console.error(`   ${tag} ${truncate(v.conclusion, 90)}`);
  });

  const section = buildVerificationSection(verifications);
  const verifiedReport = `${report.trimEnd()}\n\n${section}\n`;

  return { report: verifiedReport, verifications, extraSources };
}
