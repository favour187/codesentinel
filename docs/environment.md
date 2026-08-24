# Environment variables

Every variable, what it does, and what happens if you omit it.

All variables are validated once at startup by `src/lib/env.ts` using Zod. A malformed value
fails fast with a readable message instead of surfacing as `undefined` deep inside a request.

Copy [`.env.example`](../.env.example) to `.env.local` and edit. `.env.*` is git-ignored.

---

## Required

### `SESSION_SECRET`

Signs session cookies (HS256). **Minimum 32 characters.** The only variable you must set.

```bash
openssl rand -base64 48
```

Changing it invalidates every existing session — that is the intended way to force a global
sign-out.

---

## Core

### `APP_URL`

Public base URL of the instance, e.g. `https://codesentinel.example.com`. Used to build OAuth
callback URLs and the webhook URL shown in the UI, and as the fallback origin for redirects
when no `Host` header is usable.

Default `http://localhost:3000`. Set it correctly in production or OAuth callbacks will point
at the wrong host.

### `NODE_ENV`

`development` | `production` | `test`. Next.js sets this; override only in unusual setups.
In `production`, session cookies gain the `Secure` flag.

---

## Database

### `DATABASE_URL`

PostgreSQL connection string:

```
postgres://user:password@host:5432/codesentinel
```

**Leave empty** to use the embedded PGlite database at `./.data/pglite`. That is real
PostgreSQL compiled to WebAssembly — same SQL, same constraints — and requires no installation.

Use a real PostgreSQL server in production. PGlite is single-process and stores data on the
local filesystem, which does not survive an ephemeral deployment.

### `PGLITE_DATA_DIR`

Overrides the PGlite storage directory. Mainly useful for tests. Default `./.data/pglite`.

---

## Cryptography

### `ENCRYPTION_KEY`

Base64-encoded 32-byte key for AES-256-GCM encryption of GitHub access tokens at rest.

```bash
openssl rand -base64 32
```

If unset, a key is derived from `SESSION_SECRET`. Acceptable for local development;
**set it explicitly in production**, because otherwise rotating `SESSION_SECRET` makes every
stored token undecryptable.

---

## GitHub OAuth App

Enables "Sign in with GitHub". Without it, only the demo workspace is reachable.

Create at **GitHub → Settings → Developer settings → OAuth Apps**.
Authorization callback URL must be exactly `${APP_URL}/api/auth/github/callback`.

| Variable | Description |
| -------- | ----------- |
| `GITHUB_CLIENT_ID` | OAuth App client ID. |
| `GITHUB_CLIENT_SECRET` | OAuth App client secret. Treat as a password. |

See [`github-app-setup.md`](./github-app-setup.md).

---

## GitHub App

Enables Guardian automation: webhooks, push/PR scanning, Checks, PR comments. Distinct from
the OAuth App — an OAuth App authenticates *users*, a GitHub App acts as an *installation*
with its own fine-grained permissions.

| Variable | Description |
| -------- | ----------- |
| `GITHUB_APP_ID` | Numeric App ID. |
| `GITHUB_APP_SLUG` | URL slug, used to build install links. |
| `GITHUB_APP_PRIVATE_KEY` | PEM contents. Escape newlines as `\n` when inline. |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Alternative: path to the `.pem` file. Preferred in Docker. |
| `GITHUB_WEBHOOK_SECRET` | Shared secret for HMAC-SHA256 payload verification. |

Set `GITHUB_APP_PRIVATE_KEY` **or** `GITHUB_APP_PRIVATE_KEY_PATH`, not both.

Webhook requests without a valid signature are rejected before parsing. Never leave
`GITHUB_WEBHOOK_SECRET` empty on a public deployment.

---

## LLM provider (optional)

AI explains and prioritises deterministic findings. It never produces findings on its own, so
leaving this unconfigured costs you explanations, not detection.

| Variable | Description |
| -------- | ----------- |
| `LLM_PROVIDER` | `openai` \| `anthropic` \| `none`. Default `none`. |
| `LLM_API_KEY` | Provider API key. |
| `LLM_MODEL` | Model identifier, e.g. `gpt-4o-mini`. |
| `LLM_BASE_URL` | Override for a proxy or self-hosted, OpenAI-compatible endpoint. |

Prompts are built from retrieved, relevant context — specific findings and the code
surrounding them. The whole repository is never sent.

---

## Scanning

### `SEMGREP_PATH`

Path to a `semgrep` binary. When absent, the Semgrep-backed scanner reports itself as
unavailable rather than silently contributing no findings. All built-in scanners work without it.

### `SCAN_MAX_FILE_BYTES`

Largest file a scanner will read, in bytes. Default `1000000` (1 MB). Guards against minified
bundles and committed binaries consuming the whole scan budget.

---

## Scheduled scanning

### `CRON_SECRET`

Shared secret authorising `POST /api/guardian/run`, the endpoint that drains the scan queue.

```
Authorization: Bearer <CRON_SECRET>
```

The comparison is constant-time. Leaving this empty does not open the endpoint — it closes it
to machines entirely, and only signed-in users can trigger a drain. Scanning performs real
GitHub API work, so an unauthenticated drain endpoint is a denial-of-wallet vector.

On Vercel, add a `vercel.json` cron entry and set `CRON_SECRET` in project settings:

```json
{ "crons": [{ "path": "/api/guardian/run", "schedule": "*/5 * * * *" }] }
```

Self-hosting, any scheduler works:

```bash
*/5 * * * * curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
  https://your-instance.example.com/api/guardian/run
```

---

## Checking your configuration

The **Settings** page reports the live state of every integration, derived from
`getFeatures()` — not from a static list. Anything unconfigured names the exact variables
needed to enable it.

`GET /api/health` returns the same information as JSON:

```json
{
  "status": "ok",
  "database": { "kind": "pglite", "reachable": true },
  "features": {
    "postgres": false, "githubOAuth": false, "githubApp": false,
    "webhooks": false, "llm": false, "encryptionKey": false
  }
}
```

It returns HTTP 503 when the database is unreachable, which makes it suitable as a container
health check.

---

## Secret hygiene

- `.gitignore` excludes `.env.*` — keep it that way.
- `.env.example` must never contain a real credential.
- Logs pass through `redact()` in `src/lib/logger.ts`, which masks token-like keys.
- Rotate `SESSION_SECRET` and `ENCRYPTION_KEY` together only if you accept that stored GitHub
  tokens become undecryptable and users must reconnect.
