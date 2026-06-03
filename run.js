#!/usr/bin/env node
import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { runResearch } from "./src/agent.js";
import { runMultiPerspectiveResearch } from "./src/perspectives.js";
import { compareStrategies } from "./src/compare.js";

function parseArgs(argv) {
  let mode = "multi"; // default strategy: multi-perspective
  const words = [];
  for (const a of argv) {
    if (a === "--single") mode = "single";
    else if (a === "--multi") mode = "multi";
    else if (a === "--compare") mode = "compare";
    else if (a === "-h" || a === "--help") mode = "help";
    else words.push(a);
  }
  return { mode, question: words.join(" ").trim() };
}

function usage() {
  console.error(
    [
      '用法: node run.js [--multi|--single|--compare] "你的研究问题"',
      "",
      "  --multi    （默认）多视角策略：支持方 / 反对方 / 学术数据 三个角度并行检索后综合。",
      "  --single   单视角策略：一个中立 agent 自主搜索（原始行为）。",
      "  --compare  同一问题分别用单视角与多视角各跑一遍，并输出差异对比。",
      "",
      '例如: node run.js --compare "全民基本收入（UBI）是否可行？"',
    ].join("\n")
  );
}

function summarize(label, { rounds, sources, verifications }) {
  const disputed = (verifications ?? []).filter(
    (v) => v.verdict === "disputed"
  ).length;
  const verified = (verifications ?? []).length - disputed;
  return (
    `${label}：${rounds} 轮搜索，${sources.length} 个来源，` +
    `核查 ${verifications?.length ?? 0} 条结论（${verified} verified / ${disputed} disputed）`
  );
}

async function saveReport(question, report, suffix) {
  try {
    const dir = path.resolve("reports");
    await mkdir(dir, { recursive: true });
    const slug = question
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    const tag = suffix ? `-${suffix}` : "";
    const file = path.join(dir, `${Date.now()}-${slug || "report"}${tag}.md`);
    await writeFile(file, report, "utf8");
    console.error(`📄 报告已保存到: ${file}`);
  } catch (err) {
    console.error(`(报告未能写入文件: ${err.message})`);
  }
}

async function main() {
  const { mode, question } = parseArgs(process.argv.slice(2));

  if (mode === "help" || !question) {
    usage();
    process.exit(mode === "help" ? 0 : 1);
  }

  if (!process.env.ANTHROPIC_API_KEY || !process.env.TAVILY_API_KEY) {
    console.error(
      "缺少 API key。请先复制 .env.example 为 .env 并填入 ANTHROPIC_API_KEY 与 TAVILY_API_KEY。"
    );
    process.exit(1);
  }

  const start = Date.now();

  if (mode === "compare") {
    const { single, multi, comparison } = await compareStrategies(question);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    const combined =
      `# 单视角 vs 多视角 · 对比研究：${question}\n\n` +
      `${comparison}\n\n` +
      `---\n\n# 报告 A · 单视角\n\n${single.report}\n\n` +
      `---\n\n# 报告 B · 多视角\n\n${multi.report}\n`;

    console.log("\n" + combined + "\n");

    console.error("\n🏁 对比完成：");
    console.error("   " + summarize("单视角", single));
    console.error("   " + summarize("多视角", multi));
    console.error(`   用时 ${elapsed}s。`);

    await saveReport(question, single.report, "single");
    await saveReport(question, multi.report, "multi");
    await saveReport(question, combined, "compare");
    return;
  }

  const run =
    mode === "single" ? runResearch : runMultiPerspectiveResearch;
  const result = await run(question);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  // Traces are written to stderr; the clean Markdown report goes to stdout.
  console.log("\n" + result.report + "\n");

  const label = mode === "single" ? "单视角" : "多视角";
  console.error(`\n🏁 完成（${label}）：` + summarize(label, result) + `，用时 ${elapsed}s。`);

  await saveReport(question, result.report, mode);
}

main().catch((err) => {
  console.error(`\n❌ 出错: ${err.stack || err.message}`);
  process.exit(1);
});
