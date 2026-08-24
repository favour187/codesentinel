# Local development

---

## Prerequisites

**Node.js 20 or newer.** That is all. No PostgreSQL, no Docker, no Python.

```bash
node --version   # v20.x or later
```

---

## Setup

```bash
npm install
cp .env.example .env.local
```

Edit `.env.local` and set a `SESSION_SECRET`:

```bash
openssl rand -base64 48
```

Start:

```bash
npm run dev
```

Open <http://localhost:3000> and click **Explore the demo workspace**. The database is created
on first use — there is no separate migrate step for a fresh PGlite instance.

---

## Everyday commands

| Command | Purpose |
| ------- | ------- |
| `npm run dev` | Dev server with hot reload. |
| `npm test` | Full test suite, once. |
| `npm run test:watch` | Re-runs affected tests on save. |
| `npm run typecheck` | Strict `tsc --noEmit`. |
| `npm run lint` | ESLint. |
| `npm run build` | Production build — catches errors `dev` tolerates. |
| `npm run db:seed` | Register the demo repository. Idempotent. |

Before committing, the same three gates CI enforces:

```bash
npm run typecheck && npm run lint && npm test
```

---

## Project layout

```
src/
  app/
    (app)/          authenticated pages — auth checked once in layout.tsx
    login/          the only public page
    api/            route handlers
    globals.css     design tokens + Tailwind v4 theme
  components/
    ui/             primitives: button, card, badge, skeleton, empty-state
    layout/         sidebar, app shell, theme
    dashboard/      composed feature components
  db/
    schema.ts       Drizzle table definitions — source of truth
    bootstrap.ts    idempotent DDL for dev/test
    index.ts        driver selection and connection caching
  lib/
    env.ts          the only reader of process.env
    auth/           sessions, OAuth, access control
    ...
fixtures/demo-repo/ intentionally vulnerable sample code
tests/              Vitest suites
docs/               this documentation
```

---

## Conventions

**Configuration.** Read settings through `getEnv()` from `src/lib/env.ts`. Do not touch
`process.env` elsewhere — centralising it is what makes misconfiguration fail loudly at
startup instead of silently at runtime.

**Types.** Strict mode with `noUncheckedIndexedAccess`, so `array[0]` is `T | undefined` and
you must handle it. `any` is banned by ESLint. This is deliberate: the alternative is
`undefined` reaching production.

**Server first.** Components are server components unless they need state or effects. Add
`'use client'` only where genuinely required.

**Empty states.** Every page must render something meaningful with no data. Use `EmptyState`
or `PhasePlaceholder`. A blank page is a bug.

**Styling.** Use design tokens — `bg-[hsl(var(--surface))]`, not `bg-gray-50`. Tokens carry
light and dark values, so hard-coded colours break dark mode.

**Errors.** Catch, log with context via `createLogger`, and surface something actionable.
Never swallow an exception; never print a raw stack trace to a user.

---

## Testing changes to the database

The schema lives in two places by design (see [`database.md`](./database.md)). When you add a
table or column, update **both**:

1. `src/db/schema.ts` — the Drizzle definition.
2. `src/db/bootstrap.ts` — the DDL, and `TABLE_NAMES` for a new table.

Then:

```bash
npm test                # schema-sync test fails if the two disagree
npm run db:generate     # produce the production migration
```

---

## Troubleshooting

**Database errors after editing `src/db/index.ts`**
The client is cached on `globalThis` and survives hot reload. Restart the dev server.

**Want a clean database**

```bash
rm -rf .data && npm run db:seed
```

**Port 3000 in use**

```bash
npm run dev -- --port 3001
```

Update `APP_URL` to match, or OAuth redirects will point at the wrong port.

**Login redirects back to the login page**
The session cookie is being set for a different origin than the one you are browsing. Ensure
you are visiting the same host as `APP_URL` — `localhost` and `127.0.0.1` are different
origins to a browser. Redirects go through `src/lib/http.ts`, which prefers forwarded headers,
then `Host`, then `APP_URL`.

**Changes to `.env.local` seem ignored**
Environment is read and memoised at startup. Restart the server.

**Types fail but the editor is happy**
Your editor may use a bundled TypeScript. The project pins 5.9.3 — point your editor at the
workspace version.

---

## Using a real PostgreSQL server

Not required, but closer to production:

```bash
docker run --name codesentinel-db \
  -e POSTGRES_USER=codesentinel \
  -e POSTGRES_PASSWORD=codesentinel \
  -e POSTGRES_DB=codesentinel \
  -p 5432:5432 -d postgres:16
```

```bash
DATABASE_URL="postgres://codesentinel:codesentinel@localhost:5432/codesentinel"
```

```bash
npm run db:migrate && npm run db:seed
```

This exercises the drizzle-kit migration path rather than the bootstrap DDL — worth doing
before shipping a schema change.
