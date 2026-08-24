# Demo mode

Demo mode exists so you can evaluate CodeSentinel without connecting a GitHub account. It is
built around one rule:

> **The demo never fabricates results.** It runs real scanners over real code that ships in
> this repository. Nothing is precomputed, and demo-derived data is always labelled.

---

## Entering demo mode

Click **Explore the demo workspace** on the login page, or `POST /api/auth/demo`.

This creates (or reuses) a local user with `githubId = -1` and login `demo-user`, then
registers `codesentinel/demo-repo` pointing at `fixtures/demo-repo/`. Both steps are
idempotent — repeating them does not duplicate anything.

The demo user can only ever see repositories with `source = 'demo'`.

---

## The fixture

[`fixtures/demo-repo/`](../fixtures/demo-repo) is a small, deliberately insecure Node.js
service — 11 files, 209 scannable lines. It is ordinary source code on disk, and scanners parse
it exactly as they would parse a cloned repository.

```
fixtures/demo-repo/
├── README.md
├── package.json           outdated dependencies with known advisories
├── Dockerfile             node:14, runs as root, secret in ENV
├── src/
│   ├── lib/
│   │   ├── config.js      hardcoded AWS, Stripe, JWT and database credentials
│   │   ├── db.js          benign stub — keeps the module graph coherent, plants nothing
│   │   └── utils.js       deep nesting, prototype pollution, unused variable
│   ├── routes/
│   │   ├── admin.js       command injection via exec/execSync, path traversal
│   │   └── auth.js        jwt.decode without verification, alg:'none', timing-unsafe compare
│   └── services/
│       ├── user-service.js     SQL injection (3 sites), swallowed catch, unchecked property access
│       └── payment-service.js  float currency arithmetic, missing bounds check, no test coverage
└── tests/
    └── utils.test.js      partial coverage — deliberately incomplete
```

Every one of those problems is genuinely present in the code. They are the acceptance criteria
for the Phase 2 scanners: a rule that cannot find its planted case in this fixture is not
finished. `db.js` is deliberately clean — it exists so the import graph resolves, and it doubles
as a negative control: a scanner that reports a finding there is producing a false positive.

**Do not copy this code.** It is a target, not an example.

### Current baseline

Scanning the fixture with all six Phase 2 scanners produces **37 findings** after
cross-scanner deduplication:

| Severity | Count |
| -------- | ----- |
| Critical | 15 |
| High | 12 |
| Medium | 7 |
| Low | 1 |
| Info | 2 |

| Dimension | Score |
| --------- | ----- |
| Health | 48.5 |
| Security | 5.3 |
| Reliability | 69.4 |
| Quality | 83.7 |
| Testing | 45.0 |
| Performance | 100.0 |

Estimated remediation debt: **91.8 hours**. The fixture grades **At risk** — with 15 unresolved
critical findings, `scoreGrade` refuses a passing verdict regardless of the numeric health value.

Findings by category: security 12, secrets 6, infrastructure 5, dependencies 5, testing 3,
bugs 3, quality 2, reliability 1.

These numbers are the regression baseline. If they move, either a scanner changed or the fixture
did — reconcile deliberately, do not update this table to match a surprise.

---

## The demo narrative

The fixture supports the full loop:

1. A bad commit is introduced.
2. A scan runs and produces findings.
3. The health score decreases, visibly.
4. AI explains a finding in context.
5. A fix is generated as a reviewable diff.
6. A regression test is generated alongside it.
7. A re-scan shows the finding resolved and the score improved.

Steps 1–3 and 7 are implemented and verified end to end against a real database. A three-scan
walkthrough behaves as follows:

| Scan | Change | Findings | Health | Security | Delta |
| ---- | ------ | -------- | ------ | -------- | ----- |
| 1 | Baseline fixture | 37 | 48.5 | 5.3 | — (37 introduced) |
| 2 | Fix `eval()` in `admin.js` and `algorithm:'none'` in `auth.js` | 35 | 48.7 | 5.9 | **+0.2** (2 resolved) |
| 3 | Add `danger.js` with `exec('ping -c 1 ' + req.query.host)` | 36 | 48.6 | 5.6 | **−0.1** (1 introduced) |

The deltas are small because the fixture is already deeply unhealthy — the scoring curve
saturates, so two fixes in a 37-finding repository genuinely are a marginal improvement. That is
the honest result, not a bug. Steps 4–6 depend on the Phase 5 AI layer.

Each step is driven by the same code paths that a real repository uses. Demo mode changes the
*source* of the code being scanned, not the machinery scanning it.

---

## How demo data stays distinguishable

Keeping demo results separate from real ones is enforced in several places at once:

| Layer | Mechanism |
| ----- | --------- |
| Database | `repositories.source = 'demo'`; unique index on `(fullName, source)` keeps demo and real repositories of the same name apart. |
| Access control | The demo user owns only `source = 'demo'` repositories. |
| UI | Every demo repository carries a **Demo fixture** badge — on Overview, Settings and anywhere it is listed. |
| Sidebar | A persistent *Demo workspace* note states results come from a bundled vulnerable fixture, not a production repository. |
| Login | The demo button is accompanied by text explaining what the demo actually does. |

Removing a badge is a bug, not a cosmetic change.

---

## Limitations

Demo mode cannot demonstrate anything that requires GitHub:

- Webhook-triggered scans
- Check runs and PR comments
- Pull request risk analysis on real PRs
- Commit history and code archaeology beyond the fixture's own history

Those surfaces state that they need a connected repository rather than showing invented data.

---

## Resetting

```bash
rm -rf .data          # drop the local database entirely
npm run db:seed       # re-register the demo repository
```

Or `npm run db:seed` alone to re-register without losing other data.

---

## Adding a planted issue

When a new scanner needs a target:

1. Add the vulnerable code to the appropriate file in `fixtures/demo-repo/`.
2. Keep it realistic — the value of this fixture is that it looks like code someone would
   actually write.
3. Document it in the table above.
4. Write the scanner test that finds it, and a case asserting the rule does **not** fire on
   nearby clean code.

The fixture is excluded from `tsconfig.json` and from linting, so its deliberate mistakes do
not break the build.
