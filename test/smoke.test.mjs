// Mock-based smoke test for the agent loop (no real API calls).
// Run with: node test/smoke.test.mjs
import assert from "node:assert";
import { runResearch } from "../src/agent.js";

// Fake search returns a deterministic result.
async function fakeSearch(query) {
  return {
    query,
    answer: `concise answer for "${query}"`,
    results: [
      {
        title: `Result about ${query}`,
        url: `https://example.com/${encodeURIComponent(query)}`,
        content: "Some relevant content snippet.",
        score: 0.9,
      },
    ],
  };
}

// Fake Anthropic client: first turn decomposes + searches, then 2 searches,
// then returns a final report (stop_reason !== "tool_use").
function makeFakeClient() {
  let call = 0;
  return {
    messages: {
      create: async () => {
        call += 1;
        if (call === 1) {
          return {
            stop_reason: "tool_use",
            usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 },
            content: [
              { type: "text", text: "拆解：子问题A、子问题B。先搜A。" },
              {
                type: "tool_use",
                id: "t1",
                name: "web_search",
                input: { query: "子问题A", reason: "查证A" },
              },
            ],
          };
        }
        if (call === 2) {
          return {
            stop_reason: "tool_use",
            usage: { input_tokens: 120, output_tokens: 15, cache_read_input_tokens: 100 },
            content: [
              {
                type: "tool_use",
                id: "t2",
                name: "web_search",
                input: { query: "子问题B", reason: "查证B" },
              },
            ],
          };
        }
        return {
          stop_reason: "end_turn",
          usage: { input_tokens: 140, output_tokens: 200, cache_read_input_tokens: 100 },
          content: [
            {
              type: "text",
              text: "# 报告\n\n要点... [1][2]\n\n## 来源\n1. A - https://example.com\n2. B - https://example.com",
            },
          ],
        };
      },
    },
  };
}

async function main() {
  const { report, rounds, sources } = await runResearch("测试问题", {
    anthropicApiKey: "fake",
    client: makeFakeClient(),
    search: fakeSearch,
  });

  assert.equal(rounds, 2, "should run exactly 2 search rounds");
  assert.equal(sources.length, 2, "should collect 2 unique sources");
  assert.ok(report.includes("# 报告"), "report should contain markdown heading");
  assert.ok(report.includes("来源"), "report should contain sources section");

  console.log("\n✓ smoke test passed: rounds=%d, sources=%d", rounds, sources.length);
}

main().catch((err) => {
  console.error("✗ smoke test FAILED:", err);
  process.exit(1);
});
