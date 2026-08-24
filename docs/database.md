# Database

PostgreSQL, accessed through [Drizzle ORM](https://orm.drizzle.team). Seventeen tables — enough
to model the domain properly, few enough to keep in your head.

Schema: [`src/db/schema.ts`](../src/db/schema.ts).

---

## Two drivers, one schema

| `DATABASE_URL` | Driver | Storage | Used for |
| -------------- | ------ | ------- | -------- |
| empty | `@electric-sql/pglite` | `./.data/pglite` | Local development, tests |
| set | `postgres.js` | Your server | Production |

PGlite is PostgreSQL compiled to WebAssembly. It is not an emulation layer with a different
dialect — constraints, cascades, JSONB operators and unique indexes all behave as they do in
production. This is why development needs no database installation while still exercising real
SQL.

Selection happens in `src/db/index.ts`, which caches the client on `globalThis` so Next.js hot
reloads do not open a new connection pool on every edit.

> After editing `src/db/index.ts`, restart the dev server. The cached client survives HMR.

---

## Applying the schema

```bash
npm run db:migrate
```

The path taken depends on the driver:

- **PGlite** → executes the idempotent DDL in `src/db/bootstrap.ts` (`bootstrapSchema()`).
- **PostgreSQL** → runs drizzle-kit migrations from `./drizzle`.

Generate a migration after changing `schema.ts`:

```bash
npm run db:generate    # writes SQL into ./drizzle
npm run db:migrate     # applies it
```

### Guarding against drift

Two schema paths can disagree, and the failure mode is nasty: everything works locally and
breaks in production. `tests/db/schema-sync.test.ts` prevents this by asserting that

1. the bootstrap DDL creates exactly the tables listed in `TABLE_NAMES`,
2. every Drizzle table in `schema.ts` appears in the bootstrap DDL, and
3. every column declared in `schema.ts` exists in the bootstrapped database.

A column added to `schema.ts` but not to `bootstrap.ts` fails the test suite.

---

## Tables

### Identity and connection

| Table | Purpose |
| ----- | ------- |
| `users` | GitHub identity, profile, `accessTokenEncrypted` (AES-256-GCM). Demo user has `githubId = -1`. |
| `installations` | GitHub App installations and their account/permission metadata. |
| `repositories` | Connected repositories. `source ∈ {github, demo}`. Unique on `(fullName, source)`. |
| `repository_members` | Who may see a repository, and in what role. |
| `repository_policies` | Per-repository severity thresholds, enabled scanners, notification rules. |

### Repository content

| Table | Purpose |
| ----- | ------- |
| `commits` | Commit metadata. Unique on `(repositoryId, sha)`. |
| `pull_requests` | PR metadata, risk level, blast radius. Unique on `(repositoryId, number)`. |
| `files` | Per-file statistics captured during a scan. |
| `dependencies` | Resolved dependencies with `vulnerabilities` JSONB holding real OSV.dev records. Unique on `(scanId, ecosystem, name, manifestPath)`. |
| `tests` | Discovered tests, their targets, and coverage where available. |

### Analysis output

| Table | Purpose |
| ----- | ------- |
| `scans` | One run of the engine. Status, trigger, timings, and `scannerRuns` JSONB. |
| `findings` | The central table — see below. |
| `health_snapshots` | Six scores plus severity counts and `debtHours`, one row per completed scan. |
| `fixes` | Proposed patches. `proposed → approved → applied \| rejected`. |
| `notifications` | Delivered and pending notifications. |

### Guardian automation

| Table | Purpose |
| ----- | ------- |
| `webhook_deliveries` | One row per received delivery. `deliveryId` is **unique**, which is the whole idempotency mechanism: a redelivered event finds its own row and stops. Stores event, action, outcome, reason and duration — **never the raw payload**, which can contain private source. |
| `scan_jobs` | The durable scan queue. `status ∈ {queued, running, completed, failed, cancelled}`, plus `priority`, `attempts`/`maxAttempts`, and `lockedAt`/`lockedBy` for claim safety. |

A job is claimed with a `SELECT` followed by an `UPDATE` guarded on the row still being
unclaimed. Zero rows updated means another worker won the race — no locks held across a
scan, and no duplicate PR comments. A worker that dies mid-scan leaves `lockedAt` behind;
after 15 minutes the job is reclaimed and `attempts` is incremented.

Everything a scan produces hangs off `scans`, so deleting a scan removes exactly what that scan
created, and the history of previous runs stays intact.

---

## The `findings` table

| Column | Notes |
| ------ | ----- |
| `severity` | `critical` \| `high` \| `medium` \| `low` \| `info`. |
| `category` | `security`, `bugs`, `quality`, `dependencies`, `performance`, `reliability`, `secrets`, `architecture`, `infrastructure`. |
| `ruleId` / `scannerId` | Which rule from which scanner produced it. |
| `filePath`, `startLine`, `endLine` | Location. |
| `evidence` | The matched snippet — **masked** for secrets. |
| `confidence` | How certain the scanner is. |
| `whyItMatters`, `remediation` | Written explanation and the fix. |
| `references` | Links (CWE, advisories). Quoted in DDL — `references` is a reserved word. |
| `fingerprint` | `hash(ruleId, filePath, normalisedSnippet)`. Deduplication and cross-scan identity. |
| `status` | `open`, `resolved`, `ignored`, `false_positive`. |
| `aiExplanation` | Cached on demand. Null until a user asks. |

### Fingerprints

Because the fingerprint hashes a *normalised* snippet rather than a line number, a finding
keeps its identity when unrelated edits shift it up or down the file. That is what makes
"3 findings resolved, 1 introduced" meaningful between two scans instead of an artefact of
reformatting.

### Secrets are never stored

When a secret is detected, the database receives a fingerprint and a masked preview
(`sk_live_••••••4f2a`). The plaintext is never written and never rendered — this is enforced
where the finding is constructed, not by filtering at the UI layer.

---

## Conventions

- Primary keys are UUIDs, generated by the database.
- Timestamps are `timestamptz`, defaulted via the shared `sqlNow` helper.
- Foreign keys cascade on delete where the child cannot outlive the parent (deleting a
  repository removes its scans, findings, snapshots and fixes).
- JSONB is used where the shape is genuinely open-ended — vulnerability records, scanner run
  metadata — and never as a substitute for a column that should exist.
- Enum-like values are TypeScript union types validated in the application layer rather than
  PostgreSQL `ENUM` types, which are painful to alter.

---

## Inspecting the local database

PGlite has no `psql`. Query it from a script:

```ts
import { db } from '@/db';
import { sql } from 'drizzle-orm';

const rows = await db().execute(sql`select id, full_name, source from repositories`);
console.log(rows);
```

```bash
npx tsx path/to/script.ts
```

To start completely fresh:

```bash
rm -rf .data && npm run db:migrate && npm run db:seed
```
