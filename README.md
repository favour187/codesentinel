# CodeSentinel

**Your repository's autonomous code guardian.**

CodeSentinel connects to a GitHub repository and continuously analyses it for security
vulnerabilities, bugs, dependency risk, missing tests and architectural decay. Deterministic
scanners do the detecting; an optional LLM layer explains and prioritises what they find.

Open source, free, and self-hostable.

---

## Status

CodeSentinel is built in phases. **The scanner engine and the GitHub guardian are complete
and verified.** Every phase ends with four gates: `tsc`, `eslint`, `vitest`, `next build`.

| Phase | Scope | State |
| ----- | ----- | ----- |
| 1 | Project structure, database, auth, GitHub connection, base UI | **Done** |
| 2 | Scanner engine, findings pipeline, health scoring | **Done** |
| 3 | Guardian: webhooks, PR/push scanning, checks, PR comments, scan queue | **Done** |
| 4 | Analysis, Codebase and Fix Center pages built on the stored findings | **Done** (engine + Fix Center) |
| 5 | Repository-grounded AI explanations and digital twin | **Done** |
| 6 | Autonomous guardian, risk 2.0, CI/config, policies | **Done** |
| 7 | Deeper insights polish | Planned |
| 8 | Polish, hardening, deployment | Planned |

Phase 3 was brought forward ahead of the remaining analysis pages: continuous scanning is
what makes the product a guardian rather than a report generator, and the pages that follow
render data it produces.

Pages for unfinished phases render an explicit placeholder naming the phase that delivers
them. They never show invented metrics.

### What works today

- Email-free **demo workspace** — one click, no GitHub account required.
- **GitHub OAuth** sign-in and **GitHub App** installation (when credentials are configured).
- **PostgreSQL schema** of 24 tables, created identically in dev and production.
- **Six deterministic scanners** — secrets, security, code quality, dependencies, test
  coverage, infrastructure — that read real files on disk. On the bundled fixture they find
  **42 genuine issues across 16 files**.
- **Health scoring** across six dimensions with an explicit severity gate: a repository with
  a critical finding is labelled *At risk* regardless of its numeric score.
- **Overview dashboard** answering "is this repository safe and healthy?" above the fold.
- **Guardian**: signature-verified webhooks, a durable scan queue with retries and
  stale-lock recovery, pull-request risk assessment with a blast-radius estimate, GitHub
  Check runs, and a single sticky PR comment that is edited rather than duplicated.
- **413 automated tests** across 25 files, run against a real PostgreSQL engine — not mocks.

### What does not work yet

The Analysis, Insights and Team pages may still be thin compared with Testing and Codebase.
Phase 6 surfaces real test gaps, package advisories and the architecture map from the
digital twin. Without an LLM key every deterministic scanner still runs at full strength.

---

## How the guardian works

```
push / pull_request
  → POST /api/webhooks/github      HMAC verified against the raw body, fails closed
  → webhook_deliveries             ledger; unique delivery id makes redelivery a no-op
  → scan_jobs                      one queued job, deduped per repo + commit + PR
  → POST /api/guardian/run         worker claims jobs and scans (cron or signed-in user)
  → GitHub Check + PR comment      risk level, new findings, resolved findings, tests to add
```

A pull request is scanned at its head **and** at its base, then diffed by finding
fingerprint. Without that second scan a PR gets blamed for every pre-existing issue in the
repository, which is the fastest way to get a bot muted. A PR scan never overwrites the
repository's stored findings: a proposed branch must not move the main branch's health score.

Risk scoring is pure arithmetic and fully itemised — new findings by severity, sensitive
paths touched, diff size, blast radius, untested changes — and the Guardian page shows every
factor's contribution. Whether a PR is *blocked* is deliberately independent of the score: a
new finding at or above the policy's `failOnSeverity` blocks, however small the change.

See [`docs/github-app-setup.md`](./docs/github-app-setup.md).

---

## Quick start

Requirements: **Node.js 20+**. No database installation needed.

```bash
git clone <your-fork-url> codesentinel
cd codesentinel
npm install

cp .env.example .env.local
# Set SESSION_SECRET to any 32+ character string:
#   openssl rand -base64 48

npm run dev
```

Open <http://localhost:3000> and choose **Explore the demo workspace**.

With `DATABASE_URL` left empty, CodeSentinel starts an embedded
[PGlite](https://pglite.dev) database — real PostgreSQL compiled to WebAssembly — under
`./.data/pglite`. Nothing to install, and the SQL is identical to production.

---

## Configuration

Every setting is an environment variable, documented in
[`.env.example`](./.env.example) and in [`docs/environment.md`](./docs/environment.md).

Only `SESSION_SECRET` is required. Everything else degrades gracefully: unconfigured
integrations announce themselves as unavailable on the Settings page instead of failing at
runtime.

| Variable | Required | Purpose |
| -------- | -------- | ------- |
| `SESSION_SECRET` | **Yes** | Signs session cookies. 32+ characters. |
| `APP_URL` | Recommended | Public base URL, used for OAuth callbacks and webhooks. |
| `DATABASE_URL` | Production | PostgreSQL connection string. Empty → embedded PGlite. |
| `ENCRYPTION_KEY` | Production | Base64 32-byte key; AES-256-GCM for GitHub tokens at rest. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | For sign-in | GitHub OAuth App credentials. |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_WEBHOOK_SECRET` | For Guardian | GitHub App, for webhooks, Checks and PR comments. |
| `LLM_PROVIDER` / `LLM_API_KEY` | Optional | Enables AI explanations. |

**Never commit a filled `.env.local`.** `.gitignore` already excludes `.env.*`.

---

## Scripts

| Command | Description |
| ------- | ----------- |
| `npm run dev` | Start the development server. |
| `npm run build` | Production build. |
| `npm start` | Serve the production build. |
| `npm test` | Run the test suite once. |
| `npm run test:watch` | Re-run tests on change. |
| `npm run typecheck` | `tsc --noEmit`, strict mode. |
| `npm run lint` | ESLint. |
| `npm run db:migrate` | Apply the schema (migrations on Postgres, bootstrap DDL on PGlite). |
| `npm run db:seed` | Register the demo repository. Idempotent. |

---

## Documentation

| Document | Contents |
| -------- | -------- |
| [`docs/architecture.md`](./docs/architecture.md) | How the system fits together and why. |
| [`docs/environment.md`](./docs/environment.md) | Every environment variable in detail. |
| [`docs/database.md`](./docs/database.md) | Schema, the 17 tables, migration strategy. |
| [`docs/github-app-setup.md`](./docs/github-app-setup.md) | Creating the OAuth App and GitHub App. |
| [`docs/local-development.md`](./docs/local-development.md) | Day-to-day workflow and troubleshooting. |
| [`docs/testing.md`](./docs/testing.md) | Test layout and conventions. |
| [`docs/deployment.md`](./docs/deployment.md) | Deploying to Vercel or Docker. |
| [`docs/demo-mode.md`](./docs/demo-mode.md) | What the demo fixture is, and the honesty rules. |

---

## Principles

These are enforced in the code, not merely aspirational.

1. **Deterministic first.** Every finding originates from a scanner that read real code. AI
   explains and prioritises findings; it never invents them.
2. **No fabricated data.** The product never displays mock results. Demo data is derived
   from a real scan of a real fixture and is always badged *Demo fixture*.
3. **Never modify code without approval.** Fixes are proposed as reviewable diffs and move
   `proposed → approved → applied`. Nothing is applied silently.
4. **Secrets are never displayed.** Detected secrets are stored as a salted fingerprint plus
   a masked preview. The plaintext is never persisted or rendered.
5. **Honest empty states.** A page with no data explains why and what will populate it.
6. **Minimal surface.** Nine navigation entries. New capability deepens a page rather than
   adding another.

---

## Tech stack

Next.js 15 (App Router) · React 19 · TypeScript 5.9 (strict, `noUncheckedIndexedAccess`) ·
Tailwind CSS v4 · Drizzle ORM · PostgreSQL / PGlite · Vitest · ESLint 9.

Dependencies are kept deliberately few; `npm audit` reports **0 vulnerabilities**.

---

## Security

- Session cookies are `httpOnly`, `SameSite=Lax`, signed (HS256), and `Secure` in production.
- OAuth `state` is verified in constant time; redirects are restricted to same-origin paths.
- GitHub tokens are encrypted with AES-256-GCM at rest and never placed in a cookie.
- Webhook payloads are verified by HMAC signature.
- Security headers are set in `next.config.ts`.

To report a vulnerability, open a private security advisory on the repository.

---

## License

MIT.
