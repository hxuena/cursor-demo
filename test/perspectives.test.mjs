// Mock-based tests for the multi-perspective search flow (no real API calls).
// Run with: node test/perspectives.test.mjs
import assert from "node:assert";
import {
  PERSPECTIVES,
  runMultiPerspectiveResearch,
} from "../src/perspectives.js";
import { compareReports } from "../src/compare.js";

// Fake search: returns one result whose URL is derived from the query, plus a
// shared "overlap" URL on every call so we can assert deduplication works.
function makeFakeSearch() {
  const calls = [];
  const search = async (query) => {
    calls.push(query);
    return {
      query,
      answer: `answer for "${query}"`,
      results: [
        {
          title: `Result about ${query}`,
          url: `https://example.com/${encodeURIComponent(query)}`,
          content: "Some relevant content snippet.",
          score: 0.9,
        },
        {
          // Same URL across every search -> must be deduped in merged sources.
          title: "Shared overlapping source",
          url: "https://example.com/shared-overlap",
          content: "Overlapping content.",
          score: 0.8,
        },
      ],
    };
  };
  return { search, calls };
}

function hasToolResult(messages) {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((b) => b.type === "tool_result")
  );
}

// Fake Anthropic client that plays every role the multi-perspective flow needs:
// perspective search loops, the synthesizer, the conclusion extractor, and the
// per-conclusion skeptic.
function makeFakeClient(state) {
  return {
    messages: {
      create: async ({ system, tools = [], messages = [] }) => {
        const toolNames = tools.map((t) => t.name);
        const systemText = Array.isArray(system)
          ? system.map((s) => s.text).join("\n")
          : String(system ?? "");

        // Role: conclusion extractor.
        if (toolNames.includes("submit_conclusions")) {
          return {
            stop_reason: "tool_use",
            content: [
              {
                type: "tool_use",
                id: "c1",
                name: "submit_conclusions",
                input: { conclusions: ["综合结论：X 大体成立。"] },
              },
            ],
          };
        }

        // Role: skeptic verifying a single conclusion.
        if (toolNames.includes("submit_verdict")) {
          if (!hasToolResult(messages)) {
            return {
              stop_reason: "tool_use",
              content: [
                {
                  type: "tool_use",
                  id: "s1",
                  name: "web_search",
                  input: { query: "反驳证据", reason: "找反面证据" },
                },
              ],
            };
          }
          return {
            stop_reason: "tool_use",
            content: [
              {
                type: "tool_use",
                id: "v1",
                name: "submit_verdict",
                input: {
                  verdict: "verified",
                  reasoning: "未发现有力反面证据。",
                  counter_evidence: [],
                },
              },
            ],
          };
        }

        // Role: synthesizer (no tools, system mentions 综合分析).
        if (toolNames.length === 0 && systemText.includes("综合分析 agent")) {
          // Capture what the synthesizer was handed so the test can inspect it.
          state.synthInput = messages[0].content;
          return {
            stop_reason: "end_turn",
            content: [
              {
                type: "text",
                text:
                  "# 多视角综合报告\n\n## 执行摘要\n要点 [1][2]\n\n## 多视角交叉对照\n各视角在 X 上一致，在 Y 上分歧。\n\n## 来源\n1. A - https://example.com/a\n2. B - https://example.com/b",
              },
            ],
          };
        }

        // Role: comparer (no tools, system mentions 研究方法分析师).
        if (toolNames.length === 0 && systemText.includes("研究方法分析师")) {
          return {
            stop_reason: "end_turn",
            content: [
              {
                type: "text",
                text:
                  "## 单视角 vs 多视角 · 报告差异对比\n- 多视角覆盖更广。",
              },
            ],
          };
        }

        // Role: a perspective search loop. Each perspective searches once, then
        // emits its findings draft. We tag the draft with the perspective name
        // (extracted from the system prompt) so the test can assert all ran.
        const matched = PERSPECTIVES.find((p) =>
          systemText.includes(p.name)
        );
        const pname = matched ? matched.name : "未知视角";
        const key = `persp:${pname}`;
        state[key] = (state[key] ?? 0) + 1;

        if (state[key] === 1) {
          return {
            stop_reason: "tool_use",
            usage: { input_tokens: 50, output_tokens: 10 },
            content: [
              { type: "text", text: `从「${pname}」拆解问题。` },
              {
                type: "tool_use",
                id: "p1",
                name: "web_search",
                input: { query: `${pname} 关键证据`, reason: `检索${pname}的证据` },
              },
            ],
          };
        }
        return {
          stop_reason: "end_turn",
          usage: { input_tokens: 60, output_tokens: 30 },
          content: [
            {
              type: "text",
              text: `## ${pname} 发现摘要\n- 要点 [1]\n\n## 来源\n1. x - https://example.com/x`,
            },
          ],
        };
      },
    },
  };
}

async function testMultiPerspectiveFlow() {
  const state = {};
  const { search, calls } = makeFakeSearch();
  const client = makeFakeClient(state);

  const result = await runMultiPerspectiveResearch("某个有争议的问题", {
    anthropicApiKey: "fake",
    client,
    search,
  });

  // All three perspectives must have run their search loop.
  for (const p of PERSPECTIVES) {
    assert.ok(
      state[`persp:${p.name}`] >= 1,
      `perspective ${p.name} should have run`
    );
  }
  // Three perspectives each search once -> three searches before synthesis,
  // plus one skeptic search during verification.
  assert.ok(calls.length >= 3, "each perspective should have searched");

  // rounds = sum of perspective search rounds (3 perspectives x 1 round).
  assert.equal(result.rounds, 3, "total rounds should sum perspective rounds");

  // Source dedup: every search returned the shared-overlap URL, but it must
  // appear only once in the merged sources.
  const overlapCount = result.sources.filter(
    (s) => s.url === "https://example.com/shared-overlap"
  ).length;
  assert.equal(overlapCount, 1, "overlapping source must be deduped to one");

  // Per-perspective unique query URLs (3) + 1 shared overlap = 4 unique sources.
  assert.equal(result.sources.length, 4, "merged sources should be deduped");

  // The synthesizer must have been fed all three perspective findings.
  for (const p of PERSPECTIVES) {
    assert.ok(
      String(state.synthInput).includes(p.name),
      `synthesizer input should include ${p.name} findings`
    );
  }

  // Report should be the synthesized one + verification section.
  assert.ok(
    result.report.includes("多视角综合报告"),
    "report should be the synthesized multi-perspective report"
  );
  assert.ok(
    result.report.includes("多视角交叉对照"),
    "report should contain the cross-perspective comparison section"
  );
  assert.ok(
    result.report.includes("结论核查（Verification）"),
    "report should still run the mandatory verification pass"
  );
  assert.equal(result.verifications.length, 1, "one conclusion verified");
  assert.equal(result.perspectives.length, 3, "three perspective results");

  console.log(
    "\n✓ multi-perspective flow test passed: rounds=%d, sources=%d (deduped), perspectives=%d",
    result.rounds,
    result.sources.length,
    result.perspectives.length
  );
}

async function testCompareReports() {
  const client = makeFakeClient({});
  const comparison = await compareReports(
    "某个问题",
    "# 单视角报告\n内容 A",
    "# 多视角报告\n内容 B",
    { anthropicApiKey: "fake", client }
  );
  assert.ok(
    comparison.includes("单视角 vs 多视角"),
    "comparison should contain the comparison heading"
  );
  console.log("✓ compareReports test passed");
}

async function main() {
  await testMultiPerspectiveFlow();
  await testCompareReports();
  console.log("\n✓ all perspective tests passed");
}

main().catch((err) => {
  console.error("✗ perspective test FAILED:", err);
  process.exit(1);
});
