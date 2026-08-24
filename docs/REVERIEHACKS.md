# ReverieHacks 2026

**Track:** Software Development  
**Team:** favour187  
**Live:** https://codesentinel-3yg4.onrender.com  
**Repo:** https://github.com/favour187/codesentinel  
**Event:** [Reverie Hacks 2026](https://reverie-hacks-2026.devpost.com/) · [reveriehacks.org](https://www.reveriehacks.org/)

This is a shipped product, not a slide deck. Judges can click through without GitHub keys.

## One sentence

Code assistants write code. CodeSentinel is the repository’s **autonomous guardian**: it scans real files, maps blast radius, and never changes anything unless a human approves.

## Problem

A one-line auth change can reach APIs, data, and untested helpers. Generic chatbots invent findings and do not watch a repo continuously.

## What we built

1. Connect GitHub (or **Explore Demo**).
2. Deterministic scanners read the checkout (secrets, security, deps, quality, tests, infra, CI/CD, config).
3. A digital twin maps imports, components, routes, and test gaps.
4. Guardian can report on push/PR (checks + comments). It does **not** silent-edit.
5. Optional AI (Groq / **Featherless**, a Reverie sponsor) **explains** evidence. It never creates findings.

## Sponsor fit

| Sponsor | How we use it |
| --- | --- |
| **Render** | Production host (`render.yaml`, health `/api/health`). Eligible for Software Development Render credits. |
| **Featherless** | Optional primary-or-fallback LLM for explanations. Scanners work if the key is missing. |

## 2-minute judge path

Open: **https://codesentinel-3yg4.onrender.com/?judge=1**

1. **Explore Demo** (no login).
2. **Run scan** — same pipeline as production, on `fixtures/demo-repo` (intentional issues).
3. Overview → health, risk, top finding (badge: Demo fixture).
4. **Analysis** → real findings, not placeholders.
5. **Codebase** → architecture + packages from the twin.
6. **Testing** → test gaps.
7. **Fix Center** → explain / generate a patch. “Create PR” stays disabled without write access (honest).
8. **Reset demo** to start over. It cannot touch a GitHub repo.

`?judge=1` remembers a shortcut bar (Health, Guardian, Findings, Impact, Tests, Fix).

## What we will not fake

- No invented scan results.
- Secrets are fingerprinted and masked.
- AI failure is shown as unavailable, not as a made-up explanation.
- No automatic commits or merges.

## Submission checklist (Software Development)

Per [Devpost requirements](https://reverie-hacks-2026.devpost.com/):

- [x] Code on GitHub (MIT), `master`
- [x] Live demo on Render
- [ ] Demo video ≤ a few minutes: Demo → scan → Analysis → Codebase → Fix
- [x] This documentation (purpose, audience, features, install)

### Suggested video script (~90s)

1. Problem (15s): PRs hide blast radius; chatbots invent bugs.  
2. Demo scan (30s): Explore Demo → Run scan → health + a secret/SQL finding.  
3. Twin (20s): Codebase map + a test gap.  
4. Fix (15s): proposed diff, apply disabled on purpose.  
5. Close (10s): GitHub-connected guardian, Render-hosted, AI optional.

## Local run

```bash
npm install
cp .env.example .env.local
# SESSION_SECRET = any 32+ character string
npm run dev
```

http://localhost:3000 → Explore Demo → Run scan.

Tests: `npm test` (800+). Node 20.

## License

MIT.
