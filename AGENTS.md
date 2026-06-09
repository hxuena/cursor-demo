# AGENTS.md

## Project overview

**auto-research-agent** is a Node.js CLI that takes a research question and produces a sourced Markdown report using Claude (Anthropic API) and Tavily Search. Entry point: `run.js`.

## Cursor Cloud specific instructions

### Services

| Service | Required | Notes |
|---------|----------|-------|
| CLI (`node run.js`) | For live E2E | Needs `ANTHROPIC_API_KEY` and `TAVILY_API_KEY` in `.env` |
| Anthropic API | For live E2E | External SaaS; no local process |
| Tavily API | For live E2E | External SaaS; no local process |
| Mock tests (`npm test`) | For CI/dev without keys | No API keys or network required |

There is no web server, database, Docker, or Redis. This is a single-process CLI app.

### Standard commands

See `package.json` and `README.md` for full detail.

| Task | Command |
|------|---------|
| Install deps | `npm install` |
| Run tests | `npm test` |
| Run research (live) | `cp .env.example .env` then `node run.js "your question"` |
| Help | `node run.js --help` |

### Linting

No ESLint or other linter is configured. `npm test` is the primary automated quality check.

### Environment variables

Copy `.env.example` to `.env` and set:

- `ANTHROPIC_API_KEY` — required for live runs
- `TAVILY_API_KEY` — required for live runs

Optional tuning: `MODEL`, `MAX_ROUNDS`, `PERSPECTIVE_MAX_ROUNDS`, `SEARCH_DEPTH`, `RESULTS_PER_SEARCH`, `SKEPTIC_MAX_ROUNDS`, `SKEPTIC_CONCURRENCY`.

### Gotchas

- **stderr vs stdout**: trace/progress goes to stderr; the final Markdown report goes to stdout (redirect with `> report.md`).
- **Reports directory**: live runs also save a copy under `reports/` (created at runtime).
- **Tests use mocks**: `npm test` exercises the full agent loop (single-view, multi-perspective, verification) without real API calls. Use this to verify the environment when API keys are unavailable.
- **Node version**: requires Node.js >= 18 (ES modules).
