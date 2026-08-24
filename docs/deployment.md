# Deployment

CodeSentinel is a standard Next.js application. It deploys to Vercel, any Node host, or a
container.

---

## Render (hackathon default)

One Web Service. Scanner work runs inside the web process (the engine is not tied to HTTP and can move later).

1. Blueprint: `render.yaml`, or create a Node service with `npm ci && npm run build` / `npm start`.
2. Health check path: `/api/health`.
3. Set `APP_URL` to `https://<service>.onrender.com`.
4. Prefer a Render Postgres instance and set `DATABASE_URL`. Without it the app still boots on PGlite (ephemeral on Render).
5. Generate `SESSION_SECRET`. Set `ENCRYPTION_KEY` if you store GitHub tokens.
6. Apply schema once: `npm run db:migrate` against `DATABASE_URL`.

Do not put API keys or PEMs in the repo. Keepalive is optional and must not be required for correctness.

## Before you deploy

A production deployment differs from local development in three ways that matter:

1. **`DATABASE_URL` must point at a real PostgreSQL server.** PGlite writes to the local
   filesystem, which is ephemeral on serverless platforms — your data would vanish between
   deployments.
2. **`ENCRYPTION_KEY` must be set explicitly.** Otherwise it is derived from `SESSION_SECRET`,
   and rotating that secret makes every stored GitHub token undecryptable.
3. **`APP_URL` must be the real public URL.** OAuth callbacks and webhook URLs are built from it.

Minimum production environment:

```bash
APP_URL="https://codesentinel.example.com"
DATABASE_URL="postgres://user:pass@host:5432/codesentinel?sslmode=require"
SESSION_SECRET="<openssl rand -base64 48>"
ENCRYPTION_KEY="<openssl rand -base64 32>"
```

Add the GitHub and LLM variables as needed — see [`environment.md`](./environment.md).

---

## Vercel

1. Import the repository at <https://vercel.com/new>. The framework is detected automatically.
2. Add the environment variables above under **Settings → Environment Variables**.
3. Deploy.
4. Apply the schema once against the production database:

   ```bash
   DATABASE_URL="postgres://..." npm run db:migrate
   ```

   Run this from your machine or a one-off job. It is not part of the build.
5. Update your OAuth App callback URL and GitHub App webhook URL to the production domain.

### Notes

- Any managed PostgreSQL works — Vercel Postgres, Neon, Supabase, RDS. Use the pooled
  connection string if the provider offers one.
- Scans are CPU-bound and can exceed serverless execution limits on large repositories. For
  heavy use, run the scanning engine on a persistent host (below) rather than on Vercel
  functions.

---

## Docker

```dockerfile
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/fixtures ./fixtures
USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
```

Add `output: 'standalone'` to `next.config.ts` for this image.

Note the two security details: the container runs as a **non-root user**, and secrets arrive
through the environment rather than being baked into a layer. (The `Dockerfile` inside
`fixtures/demo-repo/` deliberately does the opposite — it is scanner bait, not a template.)

### Compose

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: codesentinel
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}
      POSTGRES_DB: codesentinel
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U codesentinel"]
      interval: 10s
      timeout: 5s
      retries: 5

  app:
    build: .
    ports: ["3000:3000"]
    environment:
      DATABASE_URL: postgres://codesentinel:${POSTGRES_PASSWORD}@db:5432/codesentinel
      APP_URL: ${APP_URL:-http://localhost:3000}
      SESSION_SECRET: ${SESSION_SECRET:?set SESSION_SECRET}
      ENCRYPTION_KEY: ${ENCRYPTION_KEY:?set ENCRYPTION_KEY}
    depends_on:
      db: { condition: service_healthy }

volumes:
  pgdata:
```

```bash
docker compose up -d
docker compose exec app npm run db:migrate
```

---

## Behind a reverse proxy

Forward the standard headers, or redirects will point at the internal address and drop session
cookies:

```nginx
location / {
    proxy_pass         http://127.0.0.1:3000;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Forwarded-Host  $host;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   X-Real-IP         $remote_addr;
}
```

`src/lib/http.ts` reads `X-Forwarded-Host` and `X-Forwarded-Proto` to reconstruct the public
origin; `APP_URL` is the fallback when neither is present.

---

## Health checks

`GET /api/health` returns `200` with a JSON body when the database is reachable and `503` when
it is not. Use it as your container or load-balancer probe.

```yaml
healthcheck:
  test: ["CMD", "wget", "-qO-", "http://localhost:3000/api/health"]
  interval: 30s
  timeout: 5s
  retries: 3
```

---

## Post-deployment checklist

- [ ] `/api/health` returns `200`, `database.kind` is `postgres`.
- [ ] Settings page reports the integrations you configured as *Configured*.
- [ ] GitHub sign-in completes and lands on the dashboard.
- [ ] OAuth callback URL matches the production domain.
- [ ] Webhook URL updated; the App's *Recent Deliveries* shows a `200`.
- [ ] `ENCRYPTION_KEY` set explicitly and backed up.
- [ ] HTTPS enforced — session cookies carry `Secure` in production.
- [ ] Database backups configured.

---

## Upgrading

```bash
git pull
npm ci
npm run db:migrate    # if the release includes migrations
npm run build
```

Check the release notes for schema changes. Back up the database before migrating.
