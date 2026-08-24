# Testing

[Vitest](https://vitest.dev), Node environment, real databases rather than mocks.

```bash
npm test              # once
npm run test:watch    # on change
npx vitest run tests/lib/http.test.ts    # a single file
```

---

## Current suite

**413 tests across 25 files**, all passing.

### Platform

| File | Tests | Covers |
| ---- | ----- | ------ |
| `tests/db/schema-sync.test.ts` | 5 | Bootstrap DDL matches `schema.ts`; unique constraints; delete cascades. |
| `tests/lib/auth.test.ts` | 10 | Session sign/verify, tampering, expiry, OAuth state, redirect safety. |
| `tests/lib/crypto.test.ts` | 9 | AES-256-GCM round-trip, tamper detection, fingerprints, masking, constant-time compare. |
| `tests/lib/env.test.ts` | 5 | Zod validation, defaults, feature detection, cache reset. |
| `tests/lib/http.test.ts` | 7 | Proxy-safe origin resolution and absolute URL building. |
| `tests/lib/utils.test.ts` | 7 | Formatting helpers. |
| `tests/lib/analysis-queries.test.ts` | 12 | Dashboard queries; severity ranking is applied in SQL *before* the limit. |
| `tests/scripts/migrate.test.ts` | 1 | `npm run db:migrate` against a fresh database, run as a real subprocess. |

### Scanner engine

| File | Tests | Covers |
| ---- | ----- | ------ |
| `tests/scanner/discovery.test.ts` | 20 | Walk, ignore rules, binary/lockfile skipping, symlinks, caps, **unreadable-root failure**. |
| `tests/scanner/finding.test.ts` | 15 | Finding construction, redaction, line-independent fingerprints, dedupe. |
| `tests/scanner/scoring.test.ts` | 20 | Deductions, size allowance, dimension mapping, grades, debt hours, diffing. |
| `tests/scanner/secrets.test.ts` | 12 | All 8 patterns, placeholder rejection, masking, `.env.example` skipping. |
| `tests/scanner/security.test.ts` | 18 | Injection/eval/traversal/crypto rules, per-site reporting, multi-line anchoring. |
| `tests/scanner/quality.test.ts` | 16 | Nesting depth, long functions, swallowed errors, unused variables. |
| `tests/scanner/dependencies.test.ts` | 18 | Manifest parsing, version-range matching, unresolvable versions. |
| `tests/scanner/testing.test.ts` | 31 | Test discovery, framework detection, case counting, gap detection, risk weighting. |
| `tests/scanner/infrastructure.test.ts` | 28 | All 7 Dockerfile rules, plus a hardened Dockerfile producing zero findings. |
| `tests/scanner/orchestrator.test.ts` | 16 | Registry integrity, shared file set, determinism, error/skip isolation. |
| `tests/scanner/persistence.test.ts` | 24 | Finding lifecycle, snapshots, intelligence pruning, failure recording. |

### Guardian and GitHub integration

| File | Tests | Covers |
| ---- | ----- | ------ |
| `tests/github/app-auth.test.ts` | 12 | App JWT shape and TTL, installation-token caching, **webhook signature verification over the raw body** — forged, malformed, legacy `sha1`, missing secret. Fails closed in every case. |
| `tests/guardian/risk.test.ts` | 33 | Every risk factor in isolation and combination; band boundaries; blocking is independent of the score; the severity floor on the reported level. |
| `tests/guardian/report.test.ts` | 27 | Comment rendering and size cap, annotation cap and level mapping, check conclusions, and that **secret findings never emit evidence**. |
| `tests/guardian/jobs.test.ts` | 19 | Enqueue and dedupe, priority ordering, conditional claim under concurrency, stale-lock reclaim, retry until `maxAttempts`, error truncation, cancellation. |
| `tests/guardian/webhook-handler.test.ts` | 32 | Event routing, draft PRs, non-default branches, tag and deletion pushes, policy gates, idempotent redelivery, and that **no raw payload is ever stored**. |
| `tests/guardian/webhook-route.test.ts` | 16 | The HTTP contract: 401 forged, 503 missing secret, 400 malformed, 200 for ignored and duplicate, 500 without leaking internal error text, 405 on `GET`. |

API-route tests for the remaining pages arrive with the phases that build them.

### Regressions these tests pin down

Several were written to fail first against real defects, and now guard the fix:

- **Severity truncated by the limit.** `getOpenFindings` limited by recency and
  only then sorted by severity in JS, so a critical finding older than the page
  size vanished from the dashboard. Ranking now happens in SQL.
- **An unreadable repository scored 100.** Discovery skipped unreadable
  directories — including the root — so a missing checkout completed as a clean
  scan with a perfect health score. The root now hard-fails.
- **`it.each` tables were not counted.** The standard table-driven form was
  missed, undercounting test cases and overstating test gaps.
- **A blocked pull request labelled "low risk".** Blocking is driven by policy severity
  while the level came from the score band, so a one-line change introducing a critical
  finding blocked the merge while the summary read *low*. The reported level is now floored
  by the worst newly introduced severity; the numeric score is untouched.
- **Resolved vs. superseded.** A re-scan must not report unfixed findings as
  fixed; `tests/scanner/persistence.test.ts` asserts the distinction directly.

---

### Why the webhook returns 503, not 401, for a missing secret

Both are refusals, but GitHub treats them differently: it retries a 503 and gives up after
repeated 401s. A deployment that forgot `GITHUB_WEBHOOK_SECRET` would otherwise permanently
lose deliveries that were perfectly valid. Our own misconfiguration must not be reported as
the sender's forgery — `tests/guardian/webhook-route.test.ts` pins this.

---

## Real databases, not mocks

`tests/helpers/test-db.ts` gives each test a fresh in-memory PGlite instance:

```ts
const db = await createTestDb();
const { repositoryId } = await seedRepository(db);
```

PGlite is genuine PostgreSQL, so these tests exercise real constraint violations, real cascade
behaviour and real JSONB semantics. Mocking the database would only verify that the mock
behaves like the mock.

### Closing instances

Each PGlite instance holds a WASM heap that garbage collection does not reclaim. Left open,
a handful of per-test databases exhaust the worker and Vitest reports *"Worker exited
unexpectedly"* even though every assertion passed.

`createTestDb()` therefore registers each client, and a global `afterEach` in `tests/setup.ts`
closes them:

```ts
afterEach(async () => {
  await closeTestDbs();
});
```

Nothing extra is required in a test file — but if you create a `PGlite` directly, close it
yourself.

---

## Environment-dependent code

`getEnv()` memoises and several functions throw when configuration is absent — `buildAuthorizeUrl`
refuses to construct a URL for an unconfigured OAuth app, by design. To test the configured
path, mutate the environment and reset the cache:

```ts
beforeAll(() => {
  process.env.GITHUB_CLIENT_ID = 'test-client-id';
  process.env.GITHUB_CLIENT_SECRET = 'test-secret';
  resetEnvCache();
});

afterAll(() => {
  delete process.env.GITHUB_CLIENT_ID;
  delete process.env.GITHUB_CLIENT_SECRET;
  resetEnvCache();
});
```

Forgetting `resetEnvCache()` produces a test that passes alone and fails in suite — the most
expensive kind of flake.

`tests/setup.ts` pins a deterministic baseline environment before any module is imported.

---

## Conventions

- Name the behaviour, not the function: *"rejects a session whose signature was tampered
  with"*, not *"verifySession works"*.
- Assert on observable behaviour, not internal calls.
- Test the failure path. Most of the security-relevant tests here assert that something is
  correctly **rejected**.
- Record a regression test next to the bug it covers, with a comment explaining the original
  failure — see the `0.0.0.0` case in `tests/lib/http.test.ts`.
- No network access in tests.

---

## What each phase must add

| Phase | Required tests |
| ----- | -------------- |
| 2 | Every scanner rule against the fixture: true positives **and** absence of false positives on clean code. Finding normalisation, deduplication, health scoring. |
| 3 | API route contracts, authorisation on repository-scoped routes. |
| 4 | Webhook signature verification, event routing, replay handling. |
| 5 | Context selection for AI prompts; graceful degradation when no LLM is configured. |
| 6 | Test discovery, coverage parsing, gap detection. |
| 7 | Policy evaluation, threshold enforcement, blast-radius computation. |

Scanner tests run against `fixtures/demo-repo/`, which contains known planted vulnerabilities.
A rule that cannot find its planted case in the fixture is not finished.

---

## Before pushing

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

All four must pass. `build` catches errors that `dev` tolerates.
