# Architecture

How CodeSentinel is put together, and the reasoning behind the decisions that are hard to
reverse later.

---

## 1. The shape of the system

```
                 GitHub
                   │
      OAuth ───────┼─────── webhooks (push / pull_request)
                   │
          ┌────────▼─────────┐
          │  Next.js app     │   App Router, server components
          │  ──────────────  │
          │  /api routes     │   auth, webhooks, scan control
          │  (app) pages     │   the nine-page UI
          └────────┬─────────┘
                   │
          ┌────────▼─────────┐
          │  Guardian        │   verify signature → ledger → queue → worker
          └────────┬─────────┘
                   │
          ┌────────▼─────────┐
          │  Scan orchestr.  │   runs scanners, merges + dedupes findings
          └────────┬─────────┘
                   │
   ┌───────────────┼────────────────┐
   │               │                │
┌──▼───┐      ┌────▼────┐      ┌────▼─────┐
│Secret│      │Dependency│     │  Bug /   │   … one module per concern
│scanner      │ scanner  │     │ quality  │
└──┬───┘      └────┬─────┘     └────┬─────┘
   └───────────────┼────────────────┘
                   │ Finding[]
          ┌────────▼─────────┐
          │   PostgreSQL     │   findings, scans, health snapshots, …
          └────────┬─────────┘
                   │
          ┌────────▼─────────┐
          │  AI layer (opt.) │   explains findings; never creates them
          └──────────────────┘

  results flow back to GitHub as a Check run + one sticky PR comment
```

The important property: **the arrow into the AI layer points out of the database, not into
it.** Findings exist before AI is involved. Turning the LLM off removes explanations, not
detections.

---

## 2. Layers

### `src/lib/` — domain logic

Pure-ish modules with no React dependency, unit-testable in isolation.

| Module | Responsibility |
| ------ | -------------- |
| `env.ts` | The **only** reader of `process.env`. Validates with Zod, memoises, exposes `getFeatures()`. |
| `crypto.ts` | AES-256-GCM encryption, hashing, fingerprints, constant-time compare, secret masking. |
| `logger.ts` | Structured logging with automatic redaction of sensitive keys. |
| `http.ts` | Proxy-safe origin resolution and redirects. |
| `auth/` | Sessions, OAuth flow, current-user resolution, access control. |
| `repositories.ts` | Repository listing, resolution, per-repository policy. |
| `analysis-queries.ts` | Read models for the dashboard. |
| `codebase-queries.ts` | Architecture, package inventory and search index. |
| `guardian-queries.ts` | Read models for the Guardian page — one query per panel, no N+1. |
| `demo/` | Demo fixture location and identity. |

Centralising `process.env` in one module means configuration errors surface as one clear
validation failure at startup rather than as `undefined` propagating into a runtime crash.
The only sanctioned exceptions are `next.config.ts` and `PGLITE_DATA_DIR` in `src/db/index.ts`,
both of which are read before the app boots.

### `src/github/` — the GitHub boundary

| Module | Responsibility |
| ------ | -------------- |
| `app-auth.ts` | App JWT minting, installation-token exchange and caching, webhook signature verification. |
| `client.ts` | The only place that speaks to the REST API. Retries 5xx, 429 and secondary rate limits — never 4xx — honouring `retry-after` up to 30s. |

Every network call goes through an injectable `fetchImpl`, which is why the whole guardian is
tested against signed fixture payloads without credentials or a live GitHub.

### `src/guardian/` — continuous scanning

| Module | Responsibility |
| ------ | -------------- |
| `webhook-handler.ts` | Decides what an event means; writes the delivery ledger; enqueues work. |
| `jobs.ts` | The queue: enqueue, dedupe, priority claim, stale-lock reclaim, retry. |
| `checkout.ts` | Materialises a commit on disk for scanning, then cleans up. |
| `pipeline.ts` | Runs a scan for a job, diffs against base, persists, records commit metadata. |
| `risk.ts` | Pure pull-request risk assessment. |
| `report.ts` | Renders the Check run and the PR comment. |
| `worker.ts` | Drains the queue within a job count and time budget. |

### `src/db/` — persistence

Drizzle ORM over PostgreSQL. See [`database.md`](./database.md).

### `src/app/` — routes

- `(app)/` — the authenticated application. The route group's `layout.tsx` performs the
  auth check **once**; individual pages assume a user.
- `login/` — the only unauthenticated page.
- `api/` — route handlers.

### `src/components/` — UI

`ui/` holds primitives (button, card, badge, skeleton, empty-state).
`layout/` holds chrome (sidebar, shell, theme).
Feature folders hold composed pieces.

---

## 3. Decisions worth explaining

### Two database drivers, one schema

`DATABASE_URL` empty → embedded PGlite (WASM PostgreSQL) at `./.data/pglite`.
`DATABASE_URL` set → `postgres.js` against a real server.

This removes the "install PostgreSQL before you can see anything" barrier without resorting
to SQLite, which would have meant a different SQL dialect in development than in production.
PGlite *is* PostgreSQL, so JSONB behaviour, constraints and cascades all match.

The risk is schema drift between the bootstrap DDL used in development and the drizzle-kit
migrations used in production. `tests/db/schema-sync.test.ts` fails the build if a table or
column exists in one path and not the other.

### Stateless sessions

A signed JWT in an `httpOnly` cookie, with no session table. Sessions are short-lived and
carry only `{ userId, login, demo? }`. This avoids a database round-trip on every request
and a table whose only purpose is to be garbage-collected. The trade-off — you cannot revoke
an individual session before expiry — is acceptable at a 7-day TTL for a self-hosted tool.

GitHub access tokens are **not** in the cookie. They live encrypted in `users.accessTokenEncrypted`.

### Proxy-safe redirects

`new URL('/', request.url)` uses the address the server is *bound* to. Behind a proxy — Vercel,
a container preview, nginx — that is the wrong origin, and a redirect to it silently drops the
session cookie because the browser treats it as a different site. `src/lib/http.ts` resolves
the public origin from `X-Forwarded-Host`/`X-Forwarded-Proto`, then `Host`, then `APP_URL`.
All redirects go through it. Regression tests live in `tests/lib/http.test.ts`.

### Theme without a dependency

A small blocking script in `<head>` sets `.dark` on `<html>` from `localStorage` before first
paint. This prevents the white flash that a React-only theme provider causes, without adding
`next-themes`.

### Scanner interface

Every scanner will satisfy one contract:

```ts
interface Scanner {
  id: string;
  name: string;
  categories: Category[];
  isAvailable(): Promise<boolean>;   // e.g. is semgrep installed?
  scan(context: ScanContext): Promise<Finding[]>;
}
```

The orchestrator runs available scanners, merges results, and deduplicates on
`fingerprint = hash(ruleId, filePath, normalisedSnippet)`. Two scanners flagging the same
line produce one finding with both attributions. Adding a scanner means adding a module and
registering it — no changes to the pipeline.

`isAvailable()` is what keeps the product honest about external tools: a missing `semgrep`
binary makes that scanner report itself unavailable rather than silently contributing nothing.

### The guardian is a queue, not a webhook handler

The obvious implementation scans inside the webhook request. It is also wrong. GitHub expects
a response in ten seconds and a scan takes minutes, so the delivery times out, GitHub retries,
and the retry starts a second scan of the same commit.

So `/api/webhooks/github` does the smallest possible amount of work: verify the signature
against the **raw** body, write a `webhook_deliveries` row, enqueue a `scan_jobs` row, return.
Scanning happens in `runWorker()`, driven by cron in production or by the signed-in user from
the Guardian page in development. The delivery ledger is the audit trail — every event that
arrived and what was decided about it — and because `deliveryId` is unique, a redelivery is a
no-op rather than a duplicate scan.

Three refusals are deliberately distinct. A bad signature is `401`. A **missing** webhook
secret is `503`, because GitHub retries a 503 and abandons repeated 401s: our misconfiguration
must not be permanently punished as the sender's forgery. Anything successfully recorded —
including events we chose to ignore — is `2xx`, so GitHub stops retrying things we understood.

### Risk is arithmetic; blocking is policy

`assessPullRequestRisk()` is a pure function over the diff: new findings weighted by severity,
sensitive paths touched, diff size, blast radius from the import graph, changed files without
tests, minus credit for findings the PR resolves. It returns every factor with its
contribution so the UI can show the reasoning instead of an unexplained number.

Whether a PR is **blocked** is a separate decision, taken from the repository policy's
`failOnSeverity` alone. A one-line change that introduces a critical finding scores low on
every size-based factor, and it must still block. Score and verdict are computed
independently and the reported level is floored by the worst newly introduced severity, so a
blocked PR can never be labelled "low risk".

### Pull requests are scanned twice

Head and base, diffed by fingerprint. Scanning only the head blames a PR for every
pre-existing issue in the repository, and a bot that cries wolf gets muted. The base scan is
reused when a completed scan of that commit already exists.

A PR scan never overwrites the repository's stored findings. A proposed branch must not move
the main branch's health score.

### Multi-agent analysis

The planned Security, Bug, Testing, Dependency, Performance and Architecture analyzers are
distinguished by the deterministic evidence they gather and the queries they run — not by
prompt text. An "agent" that only renames an LLM call is not an agent, and none are built that
way here.

### God-mode capabilities

Ambitious features (digital twin, blast radius, predictive regression risk, code archaeology,
attack-path reasoning) are implemented **only where they genuinely work**. Where they cannot
yet be delivered honestly, the module boundary is defined and the UI states plainly that the
capability is not available. No feature is faked to appear complete.

---

## 4. Request lifecycle

**Page request**

1. `(app)/layout.tsx` reads the session cookie and verifies its signature.
2. No valid session → redirect to `/login`.
3. Resolve the active repository and assert the user may access it.
4. Server components query read models in `analysis-queries.ts`.
5. HTML streams; `loading.tsx` covers the wait, `error.tsx` catches failures.

**Scan (Phase 2)**

1. Trigger — manual, webhook, or schedule.
2. Insert a `scans` row with status `running`.
3. Materialise the repository (demo → local fixture; GitHub → clone/fetch).
4. Run available scanners in parallel over a shared `ScanContext`.
5. Merge, deduplicate, and persist findings.
6. Compute the six health scores and write a `health_snapshots` row.
7. Mark the scan `completed`, recording per-scanner timings in `scannerRuns`.

Failures mark the scan `failed` with a message. A crashed scanner does not abort the run;
its status is recorded and the remaining scanners still report.

---

## 5. Security posture

| Concern | Measure |
| ------- | ------- |
| Session forgery | HS256-signed cookie, `httpOnly`, `SameSite=Lax`, `Secure` in production. |
| CSRF on OAuth | `state` nonce in a short-lived cookie, compared in constant time. |
| Open redirect | Only same-origin, root-relative redirect paths accepted. |
| Token theft | GitHub tokens AES-256-GCM encrypted at rest, never sent to the browser. |
| Webhook spoofing | HMAC-SHA256 signature verification before any processing. |
| Secret leakage | Detected secrets stored as fingerprint + masked preview only. |
| Privilege escalation | `assertRepositoryAccess` on every repository-scoped route. |
| Header hardening | CSP-adjacent headers set in `next.config.ts`. |

---

## 6. Testing strategy

See [`testing.md`](./testing.md). Tests run against real PGlite databases rather than mocks,
because the behaviour worth testing — constraints, cascades, JSONB round-trips — is exactly
what a mock would fake.
