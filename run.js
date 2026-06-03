#!/usr/bin/env node
import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { runResearch } from "./src/agent.js";

async function main() {
  const question = process.argv.slice(2).join(" ").trim();

  if (!question) {
    console.error('用法: node run.js "你的研究问题"');
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY || !process.env.TAVILY_API_KEY) {
    console.error(
      "缺少 API key。请先复制 .env.example 为 .env 并填入 ANTHROPIC_API_KEY 与 TAVILY_API_KEY。"
    );
    process.exit(1);
  }

  const start = Date.now();
  const { report, rounds, sources } = await runResearch(question);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  // Traces are written to stderr; the clean Markdown report goes to stdout.
  console.log("\n" + report + "\n");

  console.error(
    `\n🏁 完成：${rounds} 轮搜索，收集 ${sources.length} 个来源，用时 ${elapsed}s。`
  );

  // Persist a copy of the report for convenience.
  try {
    const dir = path.resolve("reports");
    await mkdir(dir, { recursive: true });
    const slug = question
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    const file = path.join(dir, `${Date.now()}-${slug || "report"}.md`);
    await writeFile(file, report, "utf8");
    console.error(`📄 报告已保存到: ${file}`);
  } catch (err) {
    console.error(`(报告未能写入文件: ${err.message})`);
  }
}

main().catch((err) => {
  console.error(`\n❌ 出错: ${err.stack || err.message}`);
  process.exit(1);
});
