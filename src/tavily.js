/**
 * Minimal Tavily Search API client.
 * Docs: https://docs.tavily.com/
 */

const TAVILY_ENDPOINT = "https://api.tavily.com/search";

/**
 * Run a single search against Tavily.
 *
 * @param {string} query - The search query.
 * @param {object} [opts]
 * @param {string} [opts.apiKey]      - Tavily API key (defaults to env).
 * @param {string} [opts.searchDepth] - "basic" | "advanced".
 * @param {number} [opts.maxResults]  - Number of results to return.
 * @returns {Promise<{query: string, answer: string|null, results: Array<{title: string, url: string, content: string, score: number}>}>}
 */
export async function tavilySearch(query, opts = {}) {
  const apiKey = opts.apiKey ?? process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error("TAVILY_API_KEY is not set.");
  }

  const body = {
    api_key: apiKey,
    query,
    search_depth: opts.searchDepth ?? "advanced",
    max_results: opts.maxResults ?? 5,
    include_answer: true,
    include_raw_content: false,
  };

  const res = await fetch(TAVILY_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Tavily request failed (${res.status}): ${text}`);
  }

  const data = await res.json();

  return {
    query,
    answer: data.answer ?? null,
    results: (data.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      content: r.content ?? "",
      score: r.score ?? 0,
    })),
  };
}
