import Anthropic from "@anthropic-ai/sdk";
import { tavilySearch } from "./tavily.js";
import { runSearchLoop, SYSTEM_PROMPT } from "./agent.js";
import { verifyReport } from "./verify.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * The three search angles. Each one biases its searches toward a different
 * stance on the same question, so the union covers a question far more evenly
 * than a single neutral pass would.
 */
export const PERSPECTIVES = [
  {
    id: "proponent",
    name: "支持方视角",
    emoji: "✅",
    instruction:
      "你这一轮研究只从【支持方 / 正面】视角出发：重点检索支持该议题的论据、正面案例、收益、成功经验，以及拥护者与受益方的观点与数据。",
  },
  {
    id: "opponent",
    name: "反对方视角",
    emoji: "⛔",
    instruction:
      "你这一轮研究只从【反对方 / 批评质疑】视角出发：重点检索反对该议题的论据、风险、缺陷、失败案例、批评者与受损方的观点，以及反驳支持方的证据。",
  },
  {
    id: "academic",
    name: "学术/数据视角",
    emoji: "📊",
    instruction:
      "你这一轮研究只从【学术 / 数据】这一中立实证视角出发：重点检索学术研究、论文、统计数据、权威机构报告、专家分析与量化证据，关注研究方法、统计口径与不确定性。",
  },
];

const SYNTHESIZER_SYSTEM = `你是一个综合分析 agent。你会收到同一个问题在多个不同视角下分别检索得到的「发现摘要」，以及一个合并去重后的统一来源清单。你的任务是把这些多视角发现整合成一份**全面、平衡**的 Markdown 研究报告。

要求：
- 报告结构：标题、执行摘要（要点）、分主题的详细分析、一个专门的「多视角交叉对照」小节、以及结尾的统一「来源」清单。
- 「多视角交叉对照」小节要明确指出：各视角在哪些点上**一致**、在哪些点上**分歧/冲突**，以及应如何看待这些分歧（例如证据强弱、口径差异）。
- 必须保持中立：完整呈现支持方与反对方的论据，不偏袒任何一方。
- 正文引用事实时，用 [n] 角标对应我给你的**统一来源清单**编号（不要沿用各视角发现里的旧编号）。
- 只使用来源清单里出现过的信息；不要编造来源或事实。
- 报告语言与问题语言保持一致。
- 结尾的「来源」清单请直接复制我给你的统一来源清单（编号 + 标题 + 完整 URL）。`;

function perspectiveSystem(perspective) {
  return `${SYSTEM_PROMPT}

【本次研究的特定视角：${perspective.name}】
${perspective.instruction}

补充要求：
- 你的检索必须聚焦于上述视角，但记录的事实必须真实、来自搜索结果，不得编造。
- 你产出的不是最终报告，而是该视角下的「发现摘要」：用要点列出本视角检索到的关键事实与论据，每条都用 [n] 角标对应结尾的「来源」清单（编号 + 标题 + 完整 URL）。`;
}

/**
 * Build a numbered, deduplicated source list string for the synthesizer.
 */
function formatSourceList(sources) {
  return sources
    .map((s, i) => `${i + 1}. ${s.title || s.url} - ${s.url}`)
    .join("\n");
}

/**
 * Run one perspective's research pass (a full search loop, no verification).
 *
 * @returns {Promise<{perspective: object, findings: string, sources: Array, rounds: number}>}
 */
export async function runPerspectiveResearch(question, perspective, opts = {}) {
  const label = perspective.name;
  const systemText = perspectiveSystem(perspective);
  const userContent = `请只从「${perspective.name}」这一视角研究下面的问题，并产出该视角的发现摘要（含 [n] 角标与结尾来源清单）：\n\n${question}`;

  const { draft, rounds, sources } = await runSearchLoop({
    ...opts,
    question,
    systemText,
    userContent,
    label,
  });

  return { perspective, findings: draft, sources, rounds };
}

/**
 * Synthesize the per-perspective findings into one balanced report.
 */
async function synthesize(question, perspectiveResults, mergedSources, opts) {
  const client = opts.client;
  const model = opts.model;

  const findingsBlock = perspectiveResults
    .map(
      (r) =>
        `### 视角：${r.perspective.name}（${r.perspective.id}）\n\n${r.findings}`
    )
    .join("\n\n---\n\n");

  const sourceList = formatSourceList(mergedSources);

  const userContent =
    `原始问题：\n${question}\n\n` +
    `下面是 ${perspectiveResults.length} 个视角各自检索得到的发现摘要：\n\n` +
    `${findingsBlock}\n\n---\n\n` +
    `统一来源清单（请只用这些编号做 [n] 引用，并在报告结尾原样复制）：\n${sourceList}\n\n` +
    `请综合以上所有视角，产出一份多视角综合研究报告。`;

  const response = await client.messages.create({
    model,
    max_tokens: 8000,
    system: SYNTHESIZER_SYSTEM,
    messages: [{ role: "user", content: userContent }],
  });

  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Run the multi-perspective research flow:
 * 1. search the same question from N angles in parallel,
 * 2. merge + dedupe sources across angles,
 * 3. synthesize one balanced report,
 * 4. run the mandatory skeptic verification pass.
 *
 * @param {string} question
 * @param {object} [opts]
 * @returns {Promise<{report: string, rounds: number, sources: Array, verifications: Array, perspectives: Array}>}
 */
export async function runMultiPerspectiveResearch(question, opts = {}) {
  const apiKey = opts.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set.");
  }

  const model = opts.model ?? process.env.MODEL ?? DEFAULT_MODEL;
  const searchDepth = opts.searchDepth ?? process.env.SEARCH_DEPTH ?? "advanced";
  const maxResults =
    opts.maxResults ?? Number(process.env.RESULTS_PER_SEARCH ?? 5);
  // Each perspective gets its own (smaller) round budget so three parallel
  // passes don't blow up token usage; falls back to MAX_ROUNDS.
  const perspectiveMaxRounds =
    opts.maxRounds ??
    Number(process.env.PERSPECTIVE_MAX_ROUNDS ?? process.env.MAX_ROUNDS ?? 5);
  const client = opts.client ?? new Anthropic({ apiKey });
  const search = opts.search ?? tavilySearch;
  const verify = opts.verify !== false;
  const perspectives = opts.perspectives ?? PERSPECTIVES;

  console.error(`\n🧭 研究问题: ${question}`);
  console.error(
    `🤖 模型: ${model} | 搜索深度: ${searchDepth} | 策略: 多视角（${perspectives
      .map((p) => p.name)
      .join(" / ")}）`
  );
  console.error(
    `\n🧩 启动 ${perspectives.length} 个视角并行检索（每个视角最多 ${perspectiveMaxRounds} 轮）…`
  );

  // 1. Run each perspective's search loop in parallel.
  const perspectiveResults = await Promise.all(
    perspectives.map((p) =>
      runPerspectiveResearch(question, p, {
        client,
        search,
        model,
        searchDepth,
        maxResults,
        maxRounds: perspectiveMaxRounds,
        anthropicApiKey: apiKey,
      })
    )
  );

  // 2. Merge + dedupe sources across all perspectives (by URL).
  const mergedSources = [];
  const seenUrls = new Set();
  for (const r of perspectiveResults) {
    for (const s of r.sources) {
      if (s.url && !seenUrls.has(s.url)) {
        seenUrls.add(s.url);
        mergedSources.push({ title: s.title, url: s.url });
      }
    }
  }

  const totalRounds = perspectiveResults.reduce((n, r) => n + r.rounds, 0);
  console.error(`\n${"═".repeat(72)}`);
  console.error(
    `🔗 三视角检索完成：合计 ${totalRounds} 轮搜索，` +
      `合并去重后得到 ${mergedSources.length} 个唯一来源。各视角原始来源数：` +
      perspectiveResults
        .map((r) => `${r.perspective.name}=${r.sources.length}`)
        .join("，") +
      "。"
  );
  console.error("🧪 进入综合阶段：整合多视角发现并标注一致/分歧…");

  // 3. Synthesize into one balanced report.
  const draft = await synthesize(question, perspectiveResults, mergedSources, {
    client,
    model,
  });

  if (!verify) {
    return {
      report: draft,
      rounds: totalRounds,
      sources: mergedSources,
      verifications: [],
      perspectives: perspectiveResults,
    };
  }

  // 4. Mandatory skeptic pass on the synthesized report.
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
      mergedSources.push(s);
    }
  }

  return {
    report: verifiedReport,
    rounds: totalRounds,
    sources: mergedSources,
    verifications,
    perspectives: perspectiveResults,
  };
}
