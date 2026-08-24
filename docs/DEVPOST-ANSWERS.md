# Proof of Possible 2026 — Devpost answers

Copy each block into the matching field. Deadline: **27 August 2026, 5:00 PM EDT**.  
Event: https://proof-of-possible-2026.devpost.com/

---

## 1. Project name and short tagline

**Name:** CodeSentinel

**Tagline:** Your repository’s autonomous code guardian.

---

## 2. Description of the problem, intended users, and solution

### Who it is for

Developers and reviewers who ship software on GitHub. The primary user is someone opening or reviewing a pull request who needs to know what the change actually does to security, tests, and the rest of the codebase — not only what the diff shows.

### The problem

A one-line change in authentication or a route can reach APIs, data stores, and untested helpers. Today people either:

- read the diff and guess, or
- paste code into a generic chatbot.

Chatbots do not watch a repository continuously. They invent findings that are not in the files. They also cannot tell you whether a secret fingerprint is still present after a “fix.” That is unsafe for a security product and useless for a reviewer who needs evidence.

### The solution

CodeSentinel is a **working** GitHub-connected guardian, not a pitch.

1. **Observe** — sign in with GitHub and connect a repo, or open **Explore Demo** (no keys). Guardian can also react to push/PR webhooks when a GitHub App is installed.
2. **Analyze** — eight deterministic scanners **read the real checkout** (or the bundled fixture): secrets, security, dependencies, quality, testing, infrastructure, CI/CD, config.
3. **Understand** — a digital twin indexes imports, symbols, components, routes, and test coverage edges so blast radius and test gaps are computed, not guessed.
4. **Explain (optional)** — Groq or Featherless may explain a finding using only packed evidence. If AI is down, scanners still finish. The UI says so; it does not invent an explanation.
5. **Propose, never apply** — Fix Center can generate a patch and tests. Creating a branch or PR stays disabled unless write access exists. Nothing is auto-merged.

Demo data is tagged `source: 'demo'` and cannot be mixed with a real repository. Discovered secrets are fingerprinted and masked — never shown in full.

**Live evidence:** https://codesentinel-3yg4.onrender.com/?judge=1 → Explore Demo → Run scan.

---

## 3. Working demo link or testing instructions

**Primary demo (judges, no account):**  
https://codesentinel-3yg4.onrender.com/?judge=1

1. Click **Explore Demo**.
2. Click **Run scan**. Wait until it reports a finding count (same scanners as production, on `fixtures/demo-repo`).
3. Overview: health score, risk, top finding (badge: Demo fixture).
4. Use the judge bar: Findings, Impact (Codebase), Tests, Fix, Guardian.
5. **Reset demo** only wipes the fixture analysis. It cannot touch a GitHub repo.

**Optional — real GitHub repo:** Connect GitHub → pick a repository → Run scan. Requires OAuth on this instance (already configured). Do not paste secrets into the form.

**Health check:** https://codesentinel-3yg4.onrender.com/api/health  
Expect `{ "status": "ok", "database": { "kind": "postgres", "reachable": true } }`.

**Local (if the live host is asleep on the free tier, wait ~30s and retry):**

```bash
git clone https://github.com/favour187/codesentinel.git
cd codesentinel
npm install
cp .env.example .env.local
# set SESSION_SECRET to any 32+ character string
npm run dev
```

Open http://localhost:3000 → Explore Demo → Run scan.

No passwords or private API keys are published for judging.

---

## 4. Source-code repository

https://github.com/favour187/codesentinel  

Branch: `master`. License: MIT. README includes install, security rules, and links to this pack.

---

## 5. Demonstration video (≤ 3 minutes)

Record this script. Keep it under three minutes. Show the **live** site, not slides.

| Time | Show | Say |
| --- | --- | --- |
| 0:00–0:20 | Landing | Code assistants write code. Reviewers still cannot see blast radius. Chatbots invent findings. |
| 0:20–1:20 | Explore Demo → Run scan → Overview | This is a real scan of a bundled fixture. Same scanners as production. Health and a concrete finding. |
| 1:20–1:50 | Analysis + Codebase | Findings come from files. The twin grouped the repo into components. |
| 1:50–2:20 | Testing + Fix Center | Test gaps are computed. A patch is a proposal. Apply to GitHub is disabled on purpose. |
| 2:20–2:50 | Settings / health | Hosted on Render. AI is optional. Secrets stay masked. |

Upload the video as **public** (YouTube unlisted or Devpost upload) and keep the link live through judging.

---

## 6. Complete list of technologies used

**Application:** Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS 4, Drizzle ORM, PostgreSQL (Render), PGlite (local/tests only), Vitest, Zod, jose (sessions), postgres.js.

**GitHub:** OAuth App (sign-in, repo list, tarball checkout), optional GitHub App (webhooks, Checks, PR comments). Octokit packages for App auth/webhooks.

**AI (optional, explain-only):** Groq Chat Completions (`openai/gpt-oss-20b` or whatever the key can access), Featherless (OpenAI-compatible). Never used to invent findings.

**Hosting / ops:** Render Web Service + Render Postgres, Node 20, standalone Next.js server, `scripts/render-start.sh`.

**Demo input:** `fixtures/demo-repo` — intentional issues so scanners have real files.

**Not used as a product feature:** generic chatbot UI, Semgrep binary (optional path; scanners work without it).

---

## 7. What was created during the hackathon

During the official period we shipped a **testable product**, not a redesign of a finished company app:

- End-to-end Next.js guardian: auth, dashboard (nine pages), scanners, digital twin, Guardian queue, Fix Center.
- Honest demo path (Explore Demo, reset, `?judge=1`) with **no fabricated results**.
- GitHub connect + **synchronous** scan using the user’s OAuth token (tarball checkout).
- Production deploy on **Render** (iframe-safe headers, 512 MB heap caps, standalone start, health probe).
- Optional grounded AI (Groq / Featherless) with fallback, model 404 recovery, and no silent AI failures.
- Mobile and desktop layout so judges can review on a phone.
- Documentation for judges and operators (`README`, `docs/DEMO.md`, `docs/PROOF-OF-POSSIBLE.md`, this file).

Pre-existing general-purpose ideas (static analysis, GitHub Apps) are industry practice. The implementation, fixture, twin, and responsible-AI boundary were built as this project.

---

## 8. Disclosure of AI tools, pre-existing code, APIs, datasets, templates, third-party assets

**AI used to build the project:** Arena.ai Agent Mode and other coding assistants helped write and edit source. The team reviewed behaviour, security constraints, and what the UI claims.

**AI inside the product:** Groq and Featherless APIs, only after deterministic findings exist. Prompts are redacted. Outputs are schema-validated. Failure is shown as unavailable.

**APIs / third parties:** GitHub REST (OAuth, tarball, optional App). Render hosting and Postgres. No user dataset was scraped.

**Templates / starter:** No commercial UI kit beyond open-source Radix primitives and Lucide icons. Tailwind and Next.js defaults.

**Pre-existing code:** Open-source dependencies in `package.json` / lockfile (Next, React, Drizzle, jose, Octokit, etc.). The demo fixture is original bait code, not a customer’s repository.

**Datasets:** None. Scanners operate on the connected repo or the fixture.

**Secrets:** No production API keys are in the repository. `.env.example` is empty placeholders.

---

## 9. Team members and contributions

Update names if more people should be listed. Default from the public repo:

| Name | Role | Contributions |
| --- | --- | --- |
| favour187 | Builder | Product design, implementation, GitHub integration, scanners/twin/Guardian/Fix Center, Render deploy, demo/judge path, documentation, Devpost submission. |

If you have teammates, add a row each with **specific** files or features they owned. Do not list people who did not contribute.

---

## 10. Known limitations, risks, privacy, future work

**Limitations**

- Apply / create PR is disabled without a GitHub App that has write permission. That is intentional.
- Generated tests are **not executed**.
- Team invites and uploaded coverage reports are not implemented.
- Render free tier is 512 MB; very large repositories may run out of memory. Heap is capped.
- Guardian background jobs need the App + installation; manual scan uses the user token instead.
- Demo fixture findings must not be read as a scan of a customer’s production app.

**Privacy and safety**

- Session cookies are httpOnly, signed, Secure in production.
- GitHub OAuth tokens are encrypted at rest (AES-256-GCM) when `ENCRYPTION_KEY` is set.
- Webhooks require HMAC verification.
- Discovered secrets are never stored or displayed in full (fingerprint + mask).
- Repository access is checked per user. Demo reset cannot target a GitHub repo.
- We do not ask judges for passwords.

**Risks**

- A wrong or Enterprise-only Groq model ID returns an error instead of a fake explanation.
- OAuth tokens are powerful (`repo` scope) because private code cannot be read otherwise. Users should revoke unused grants.
- Static analysis has false positives; AI false-positive analysis is advisory only and cannot dismiss a finding by itself.

**Future improvements**

- Dedicated scan worker for large repos; richer policy UI; ingested coverage; notification sinks; GitHub App write path for optional, explicit PRs.

---

## Suggested “Built with” tags on Devpost

`nextjs` `typescript` `react` `tailwindcss` `postgresql` `drizzle` `github-api` `render` `groq` `featherless` `static-analysis` `security`

---

## Short “About” blurb (if Devpost has one box)

CodeSentinel is a GitHub-connected code guardian. It scans real files, builds a digital twin for blast radius and test gaps, and optionally uses an LLM only to explain evidence it already has. Fixes are diffs. Nothing is applied without approval. Judges can prove it in two minutes: https://codesentinel-3yg4.onrender.com/?judge=1 → Explore Demo → Run scan.
