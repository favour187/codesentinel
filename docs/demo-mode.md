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
service — 16 files, 329 scannable lines. It is ordinary source code on disk, and scanners parse
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
│   ├── auth/
│   │   ├── session.js     predictable session ids, no expiry, unbounded store
│   │   └── permissions.js fail-open access control (CWE-285)
│   ├── frontend/
│   │   ├── login-form.js  innerHTML XSS sink (CWE-79)
│   │   └── dashboard.js   XSS sink, depends on auth + user + payment services
│   ├── routes/
│   │   ├── admin.js       command injection via exec/execSync, path traversal
│   │   └── auth.js        jwt.decode without verification, alg:'none', timing-unsafe compare
│   └── services/
│       ├── user-service.js     SQL injection (3 sites), swallowed catch, unchecked property access
│       └── payment-service.js  float currency arithmetic, missing bounds check, no test coverage
└── tests/
    ├── utils.test.js      partial coverage — deliberately incomplete
    └── session.test.js    covers createSession/getSession only; the rest is a planted gap
```

The `auth/` and `frontend/` layers exist for the Phase 5 Digital Twin: `session.js` is imported
by routes, permissions and (transitively) the frontend, so it has a genuinely large blast radius,
and the graph has enough depth for component grouping to mean something.

Every one of those problems is genuinely present in the code. They are the acceptance criteria
for the Phase 2 scanners: a rule that cannot find its planted case in this fixture is not
finished. `db.js` is deliberately clean — it exists so the import graph resolves, and it doubles
as a negative control: a scanner that reports a finding there is producing a false positive.

**Do not copy this code.** It is a target, not an example.

### Current baseline

Scanning the fixture with all six Phase 2 scanners produces **42 findings** after
cross-scanner deduplication:

| Severity | Count |
| -------- | ----- |
| Critical | 16 |
| High | 16 |
| Medium | 7 |
| Low | 1 |
| Info | 2 |

| Dimension | Score |
| --------- | ----- |
| Health | 46.6 |
| Security | 4.9 |
| Reliability | 69.4 |
| Quality | 83.7 |
| Testing | 32.9 |
| Performance | 100.0 |

Estimated remediation debt: **91.8 hours**. The fixture grades **At risk** — with 16 unresolved
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
| 1 | Baseline fixture (11-file version) | 37 | 48.5 | 5.3 | — (37 introduced) |
| 2 | Fix `eval()` in `admin.js` and `algorithm:'none'` in `auth.js` | 35 | 48.7 | 5.9 | **+0.2** (2 resolved) |
| 3 | Add `danger.js` with `exec('ping -c 1 ' + req.query.host)` | 36 | 48.6 | 5.6 | **−0.1** (1 introduced) |

> These three rows were measured against the original 11-file fixture. Phase 5 extended the
> fixture to 16 files (baseline now 42 findings / health 46.6), so the absolute numbers differ;
> the delta behaviour they demonstrate is unchanged.

The deltas are small because the fixture is already deeply unhealthy — the scoring curve
saturates, so two fixes in a 37-finding repository genuinely are a marginal improvement. That is
the honest result, not a bug.

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
