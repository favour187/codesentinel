# CodeSentinel

**Your repository's autonomous code guardian.**

Code assistants help developers *write* code. CodeSentinel helps them **understand, protect, and verify** a repository.

It connects to GitHub (or a local demo fixture), runs deterministic scanners on real files, maps how code depends on itself, and optionally uses an LLM only to explain evidence it already has. Fixes are proposed as diffs. Nothing is applied without approval.

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

## Run locally

Requires Node 20+.

```bash
npm install
cp .env.example .env.local
# set SESSION_SECRET to any 32+ character string
npm run dev
```

Open http://localhost:3000 → **Explore Demo** → **Run scan**.

```bash
npm test
npm run build
npm start
```

PostgreSQL is optional locally (embedded PGlite if `DATABASE_URL` is empty). See [`.env.example`](./.env.example).

## Deploy

`render.yaml` describes a Node web service. Health check: `GET /api/health`. Set `APP_URL`, `SESSION_SECRET`, `DATABASE_URL`, and `ENCRYPTION_KEY`. Start command: `sh scripts/render-start.sh`.

## Security

- Tokens encrypted at rest (AES-256-GCM)
- Discovered secrets fingerprinted and masked
- Webhook HMAC verification
- No automatic code modification

## License

MIT. See [LICENSE](./LICENSE).
