# CodeSentinel

**Your repository's autonomous code guardian.**

Code assistants help developers *write* code. CodeSentinel helps them **understand, protect, and verify** a repository.

It connects to GitHub (or a local demo fixture), runs deterministic scanners on real files, maps how code depends on itself, and optionally uses an LLM only to explain evidence it already has. Fixes are proposed as diffs. Nothing is applied without approval.

---

## Problem

Pull requests change more than the files in the diff. A one-line auth change can reach APIs, data, and untested helpers. Generic chatbots do not watch that surface continuously, and they invent findings.

## Solution

1. **Observe** pushes and pull requests (or a manual scan).
2. **Analyze** with scanners that read the checkout.
3. **Understand** impact via a digital twin (imports, components, routes).
4. **Protect** with Guardian checks and comments — reporting, not silent edits.
5. **Verify** that a fingerprint is gone after an approved change.

## How it works

```
GitHub webhook or Run scan
        ↓
   checkout / fixture
        ↓
   scanners + twin index
        ↓
   findings + health + events
        ↓
   optional AI explanation
        ↓
   reviewable patch (never auto-merged)
```

## What is implemented

- GitHub OAuth + GitHub App Guardian (webhooks, Checks, sticky PR comments)
- Eight scanners: secrets, security, dependencies, quality, testing, infrastructure, CI/CD, config
- Digital twin, blast radius, test-gap intelligence
- Repository risk 2.0 (deterministic)
- Fix Center with explicit approval
- Demo workspace that uses the **same** pipeline on `fixtures/demo-repo`

AI is optional. If Featherless and Groq are both down, Guardian and scanners still run.

## Security

- Tokens encrypted at rest (AES-256-GCM)
- Discovered secrets fingerprinted and masked — never shown in full
- Webhook HMAC verification
- Per-repository authorization
- No automatic code modification

## Demo (judges)

```bash
npm install
cp .env.example .env.local
# set SESSION_SECRET to any 32+ character string
npm run dev
```

Open http://localhost:3000 → **Explore Demo** → **Run scan**.

Script: [`docs/DEMO.md`](./docs/DEMO.md)

Add `?judge=1` for a shortcut bar. **Reset demo** (demo only) wipes fixture analysis and re-scans. It cannot touch a GitHub repository.

## Install

Requires Node 20+. PostgreSQL is optional locally (embedded PGlite if `DATABASE_URL` is empty).

See [`.env.example`](./.env.example) and [`docs/environment.md`](./docs/environment.md).

```bash
npm run db:migrate   # when using a real Postgres
npm test
npm run build
npm start
```

## Deploy (Render)

One **Web Service**. No separate worker.

1. Use `render.yaml` or create a Node web service (`npm ci && npm run build`, start `npm start`).
2. Health check: `GET /api/health`
3. Set `APP_URL`, `SESSION_SECRET`, and preferably `DATABASE_URL` + `ENCRYPTION_KEY`.
4. After first deploy, run `npm run db:migrate` against that database once.

Details: [`docs/deployment.md`](./docs/deployment.md)

## Tech stack

Next.js 15 · React 19 · TypeScript · Tailwind · Drizzle · PostgreSQL / PGlite · Vitest

## Roadmap

Deeper policy UI, more notification sinks, ingested coverage reports, a dedicated scan worker for very large repos.

## License

MIT.
