// Mock-based smoke test for the agent loop + skeptic verification pass
// (no real API calls). Run with: node test/smoke.test.mjs
import assert from "node:assert";
import { runResearch } from "../src/agent.js";
import { verifyConclusion, verifyReport } from "../src/verify.js";

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

// Returns true if the message list already carries a tool_result (i.e. a search
// has been executed in this conversation). Used by the fake skeptic to decide
// when to stop searching and submit a verdict.
function hasToolResult(messages) {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((b) => b.type === "tool_result")
  );
}

// Fake Anthropic client. It branches on the tools / messages it receives so it
// can play three roles: the main research loop, the conclusion extractor, and
// the per-conclusion skeptic.
function makeFakeClient() {
  let researchCall = 0;
  return {
    messages: {
      create: async ({ tools = [], messages = [] }) => {
        const toolNames = tools.map((t) => t.name);

        // Role: conclusion extractor.
        if (toolNames.includes("submit_conclusions")) {
          return {
            stop_reason: "tool_use",
            content: [
              {
                type: "tool_use",
                id: "c1",
                name: "submit_conclusions",
                input: { conclusions: ["结论一：A 成立。", "结论二：B 成立。"] },
              },
            ],
          };
        }

        // Role: skeptic (red-team) verifying a single conclusion.
        if (toolNames.includes("submit_verdict")) {
          if (!hasToolResult(messages)) {
            // First search for counter-evidence.
            return {
              stop_reason: "tool_use",
              content: [
                {
                  type: "tool_use",
                  id: "s1",
                  name: "web_search",
                  input: { query: "反驳证据", reason: "寻找反面证据" },
                },
              ],
            };
          }
          // Dispute the conclusion that mentions B; verify the rest.
          const userText = messages[0].content;
          const dispute = userText.includes("结论二");
          return {
            stop_reason: "tool_use",
            content: [
              {
                type: "tool_use",
                id: "v1",
                name: "submit_verdict",
                input: dispute
                  ? {
                      verdict: "disputed",
                      reasoning: "找到了矛盾证据。",
                      counter_evidence: [
                        { point: "权威来源给出相反结论。", url: "https://counter.example.com/b" },
                      ],
                    }
                  : { verdict: "verified", reasoning: "未发现有力反面证据。", counter_evidence: [] },
              },
            ],
          };
        }

        // Role: main research loop.
        researchCall += 1;
        if (researchCall === 1) {
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
        if (researchCall === 2) {
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

async function testFullFlow() {
  const { report, rounds, sources, verifications } = await runResearch("测试问题", {
    anthropicApiKey: "fake",
    client: makeFakeClient(),
    search: fakeSearch,
  });

  assert.equal(rounds, 2, "should run exactly 2 search rounds");
  assert.ok(report.includes("# 报告"), "report should contain markdown heading");
  assert.ok(report.includes("来源"), "report should contain sources section");

  // Verification assertions.
  assert.equal(verifications.length, 2, "should verify 2 conclusions");
  const verdicts = verifications.map((v) => v.verdict).sort();
  assert.deepEqual(verdicts, ["disputed", "verified"], "one disputed, one verified");

  assert.ok(
    report.includes("结论核查（Verification）"),
    "report should contain a verification section"
  );
  assert.ok(report.includes("[verified]"), "report should label a verified conclusion");
  assert.ok(report.includes("[disputed]"), "report should label a disputed conclusion");
  assert.ok(
    report.includes("https://counter.example.com/b"),
    "disputed conclusion should attach counter-evidence URL"
  );
  // Counter-evidence URL should be merged into collected sources.
  assert.ok(
    sources.some((s) => s.url === "https://counter.example.com/b"),
    "counter-evidence source should be merged into sources"
  );

  console.log(
    "\n✓ full-flow test passed: rounds=%d, sources=%d, verified/disputed=%j",
    rounds,
    sources.length,
    verdicts
  );
}

async function testDisputedNeedsEvidence() {
  // A skeptic claiming "disputed" but providing no counter-evidence must be
  // downgraded to "verified" to keep the disputed-needs-evidence rule honest.
  const client = {
    messages: {
      create: async () => ({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "v",
            name: "submit_verdict",
            input: { verdict: "disputed", reasoning: "声称有问题但没给证据。", counter_evidence: [] },
          },
        ],
      }),
    },
  };

  const res = await verifyConclusion("一个没有反面证据的结论。", {
    anthropicApiKey: "fake",
    client,
    search: fakeSearch,
  });
  assert.equal(res.verdict, "verified", "disputed without evidence -> verified");
  assert.equal(res.counterEvidence.length, 0, "no counter-evidence retained");

  console.log("✓ disputed-without-evidence downgrade test passed");
}

async function main() {
  await testFullFlow();
  await testDisputedNeedsEvidence();
  console.log("\n✓ all smoke tests passed");
}

main().catch((err) => {
  console.error("✗ smoke test FAILED:", err);
  process.exit(1);
});
