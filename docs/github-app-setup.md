# GitHub setup

CodeSentinel uses **two** GitHub integrations. They do different jobs and you can configure
them independently.

| | OAuth App | GitHub App |
| --- | --- | --- |
| Authenticates | A user | An installation |
| Enables | Sign-in, listing your repositories | Webhooks, PR scanning, Checks, PR comments |
| Needed for | Any non-demo use | Guardian automation |

Neither is required to explore the demo workspace.

---

## Part 1 — OAuth App (sign-in)

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Fill in:
   - **Application name** — `CodeSentinel` (or `CodeSentinel (local)`).
   - **Homepage URL** — your `APP_URL`, e.g. `http://localhost:3000`.
   - **Authorization callback URL** — `http://localhost:3000/api/auth/github/callback`

   The callback must match `${APP_URL}/api/auth/github/callback` **exactly**, including scheme
   and port. A mismatch produces `redirect_uri_mismatch` at sign-in.
3. **Register application**, then **Generate a new client secret**. Copy it immediately; GitHub
   shows it once.
4. Add both values to `.env.local`:

   ```bash
   GITHUB_CLIENT_ID="Iv1.xxxxxxxxxxxx"
   GITHUB_CLIENT_SECRET="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
   ```

5. Restart the dev server. The login page now offers **Continue with GitHub**, and Settings
   reports *GitHub OAuth: Configured*.

### Scopes

CodeSentinel requests `read:user` and `repo`. `repo` is required to read private repository
contents; GitHub does not offer a read-only variant that covers private code. If you only
intend to analyse public repositories, `public_repo` is sufficient — change the scope in
`src/lib/auth/oauth.ts`.

---

## Part 2 — GitHub App (Guardian automation)

Needed for automatic scanning on push and pull request, Checks runs, and review comments.

1. Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Basics:
   - **GitHub App name** — must be globally unique, e.g. `codesentinel-yourname`.
   - **Homepage URL** — your `APP_URL`.
3. **Webhook**:
   - Tick **Active**.
   - **Webhook URL** — `${APP_URL}/api/webhooks/github`
   - **Webhook secret** — generate one and keep it:

     ```bash
     openssl rand -hex 32
     ```

   For local development GitHub cannot reach `localhost`; see *Local webhooks* below.
4. **Repository permissions**:

   | Permission | Access | Why |
   | ---------- | ------ | --- |
   | Contents | Read-only | Read source to scan it. |
   | Metadata | Read-only | Mandatory. |
   | Pull requests | Read & write | Post review comments and summaries. |
   | Checks | Read & write | Publish check runs on commits. |
   | Issues | Read & write | Optional — open issues for findings. |
   | Commit statuses | Read-only | Correlate with existing CI. |

   Grant nothing else. CodeSentinel never needs write access to repository contents — fixes
   are delivered as reviewable patches, never pushed.
5. **Subscribe to events**: `Push`, `Pull request`, `Pull request review`, `Check suite`,
   `Installation`, `Installation repositories`.
6. **Where can this app be installed** — *Only on this account*, unless you are hosting for others.
7. **Create GitHub App**. On the resulting page:
   - Note the **App ID**.
   - Note the **slug** from the URL (`.../apps/<slug>`).
   - **Generate a private key** — a `.pem` file downloads. It is shown only once.
8. Configure `.env.local`:

   ```bash
   GITHUB_APP_ID="123456"
   GITHUB_APP_SLUG="codesentinel-yourname"
   GITHUB_APP_PRIVATE_KEY_PATH="./secrets/codesentinel.private-key.pem"
   GITHUB_WEBHOOK_SECRET="the-secret-from-step-3"
   ```

   Or inline the key, escaping newlines as `\n`:

   ```bash
   GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----\n"
   ```

   Store the `.pem` outside version control. Add `secrets/` to `.gitignore` if you use the path form.
9. **Install App** in the sidebar, then choose the repositories to grant access to.
10. Restart. Settings reports *GitHub App & webhooks: Configured*.

---

## Local webhooks

GitHub cannot deliver to `localhost`. Expose your dev server with a tunnel:

```bash
# cloudflared
cloudflared tunnel --url http://localhost:3000

# or ngrok
ngrok http 3000
```

Set both the App's **Webhook URL** and your `APP_URL` to the public tunnel URL, then restart.
Free tunnel URLs change on every restart — update both places each time.

Deliveries and their responses are visible under **Advanced → Recent Deliveries** on the App
settings page, with a **Redeliver** button that is invaluable when debugging handlers.

---

## How a delivery becomes a scan

```
GitHub event
  → POST /api/webhooks/github     verify HMAC over the RAW body, fail closed
  → webhook_deliveries            ledger row; unique delivery_id = idempotency
  → route the event               push / pull_request / check_run / installation
  → scan_jobs                     one queued job (deduped per repo+commit+PR)
  → POST /api/guardian/run        worker claims jobs and scans
  → GitHub Check + PR comment     results posted back
```

The endpoint replies as soon as the job is queued — GitHub abandons a delivery after about
ten seconds, so scanning never happens inline.

### Response codes

| Code | Meaning |
| ---- | ------- |
| `200` | Understood. Includes events deliberately ignored (draft PR, non-default branch, `labeled`) — a non-2xx would make GitHub retry an event we chose to skip. |
| `400` | Missing `X-GitHub-Event` / `X-GitHub-Delivery`, or the body is not JSON. |
| `401` | Signature missing or invalid. Deliveries are never processed unverified. |
| `503` | `GITHUB_WEBHOOK_SECRET` is not set on this deployment. GitHub retries a 503; it gives up on repeated 401s, so our own misconfiguration must not look like forgery. |
| `500` | Infrastructure failure (e.g. the database was unreachable). GitHub retries. |

Redelivering an event is safe: the unique `delivery_id` makes the second attempt a no-op.

### Which events trigger a scan

| Event | Scanned when | Skipped when |
| ----- | ------------ | ------------ |
| `push` | Commit on the **default branch** | Feature branches (their PR covers them), tags, branch deletions, zero-sha |
| `pull_request` | `opened`, `reopened`, `synchronize`, `ready_for_review` | Drafts (until ready), `labeled`, `assigned`, `closed`, `edited` |
| `check_run` | `rerequested` — the **Re-run** button | Every other lifecycle action |
| `installation`, `installation_repositories` | Syncs repository access | — |
| `ping` | Acknowledged with `pong` | — |

`repository_policies` gates all of it: `scanOnPush`, `scanOnPullRequest`, and the repository's
`guardianEnabled` flag. Every skip is recorded with its reason and shown in the Guardian
delivery log, so silence is always explainable.

The raw payload is **never stored** — it can contain private source. Only event metadata,
outcome and duration are retained.

---

## Running the worker

Queued jobs do nothing until a worker drains them. Both paths call the same code.

```bash
# Manually, while developing
curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/guardian/run
```

Vercel Cron, in `vercel.json`:

```json
{ "crons": [{ "path": "/api/guardian/run", "schedule": "*/5 * * * *" }] }
```

Each invocation claims at most 5 jobs within a 4-minute budget, staying inside serverless
limits. Claiming uses a conditional `UPDATE`, so two concurrent workers can never take the
same job — no duplicate scans, no duplicate PR comments. A worker that dies mid-scan has its
job reclaimed after 15 minutes, and a failing job is retried up to 3 times before being marked
failed with its error recorded.

See `docs/environment.md` for `CRON_SECRET`.

---

## Production (Render)

1. Set `APP_URL` to `https://<service>.onrender.com`.
2. OAuth callback: `https://<service>.onrender.com/api/auth/github/callback`
3. Webhook: `https://<service>.onrender.com/api/webhooks/github`
4. Same permissions and events as above.
5. Put `GITHUB_APP_PRIVATE_KEY` in the Render env (newlines as `\n`). Never commit the PEM.

Development uses localhost (or a tunnel). Demo uses no GitHub at all (`source: 'demo'`). Production requires `DATABASE_URL` + `SESSION_SECRET` + `ENCRYPTION_KEY`.

## Verification

| Check | Expected |
| ----- | -------- |
| `GET /api/health` | `features.githubOAuth` and `features.githubApp` are `true`. |
| Settings page | Both integrations show *Configured*. |
| Login page | Offers **Continue with GitHub**. |
| Recent Deliveries | A `ping` event with response `200`. |
| Guardian page | Shows *Guardian is connected and receiving events*, with the delivery in the log. |

---

## Troubleshooting

**`redirect_uri_mismatch`** — the callback URL does not match `${APP_URL}/api/auth/github/callback`
character for character. Check scheme, port and trailing slash.

**Webhooks return 401** — `GITHUB_WEBHOOK_SECRET` differs from the App's configured secret.
Signature verification runs before parsing, so a mismatch always yields 401.

**Webhooks return 503** — `GITHUB_WEBHOOK_SECRET` is not set at all. Set it and redeliver.

**Deliveries return 200 but nothing scans** — the event was deliberately ignored. Open the
Guardian page: each delivery records the reason (draft PR, non-default branch, policy
disabled). If instead jobs are piling up as *queued*, no worker is draining them — see
*Running the worker* above.

**Webhooks return 404** — the URL is wrong, or you are still pointing at a stale tunnel.

**`error:0909006C:PEM routines:get_name:no start line`** — the inline private key lost its
newlines. Use `GITHUB_APP_PRIVATE_KEY_PATH` instead, or escape them as `\n`.

**Repositories missing after install** — the installation grants access to selected
repositories only. Reconfigure the installation and add them.

**`state_mismatch` at sign-in** — the state cookie expired (10 minutes) or was blocked. Retry;
if it persists, check that cookies are not being stripped by a proxy.
