# Proof of Possible 2026

**Tagline:** Don’t pitch the future. Build evidence.  
**Event:** [Proof of Possible 2026](https://proof-of-possible-2026.devpost.com/)  
**Deadline:** 27 August 2026, 5:00 PM EDT  
**Direction:** Work Rewritten + Intelligent Systems (trustworthy automation, not a chatbot)  
**Live:** https://codesentinel-3yg4.onrender.com/?judge=1  
**Repo:** https://github.com/favour187/codesentinel

Judges can evaluate this remotely. No login required for the demo fixture.

## Project name and tagline

**CodeSentinel** — *Your repository’s autonomous code guardian.*

## Problem, users, solution

**Users:** developers and reviewers who ship GitHub repositories.

**Problem:** Pull requests hide blast radius. Generic AI chatbots invent findings and do not watch a repo continuously.

**Solution (evidence, not a pitch):**
1. Connect GitHub or **Explore Demo**.
2. Deterministic scanners **read real files** (secrets, security, deps, quality, tests, infra, CI/CD, config).
3. A digital twin maps imports, components, routes, and test gaps.
4. Optional AI (Groq / Featherless) **explains existing evidence only**. It never creates findings.
5. Fixes are proposed diffs. Nothing is applied without approval.

## Judge path (2 minutes)

https://codesentinel-3yg4.onrender.com/?judge=1

1. **Explore Demo**
2. **Run scan** on `fixtures/demo-repo` (same scanners as production)
3. Overview → health + a real finding
4. Analysis → Codebase → Testing → Fix Center
5. **Reset demo** to repeat. It cannot touch a GitHub repo.

`?judge=1` keeps a shortcut bar.

## What was built for this event

Working product on Render: OAuth, scan pipeline, twin, Guardian, Fix Center, demo fixture, health endpoint, mobile/desktop layout. Core judged work is this shipped instance — not a mockup.

## Technologies

Next.js 15 · React 19 · TypeScript · Tailwind · Drizzle · PostgreSQL · Vitest · GitHub OAuth/App · Groq · Featherless · Render

## Disclosure

- Open-source libraries listed in `package.json`.
- Demo fixture in `fixtures/demo-repo` is **intentional** vulnerable bait so scanners have real input.
- AI (Groq, Featherless) is optional and evidence-bounded. If it is down, scanners still run.
- AI-assisted development was used for implementation; the team is responsible for originality, licensing, and behaviour.
- GitHub tokens are encrypted at rest. Discovered secrets are fingerprinted, never shown in full.

## Known limitations

- Manual GitHub scans use the signed-in user’s token; Guardian automation needs a GitHub App install.
- Apply-to-GitHub / create PR stays disabled without write access (honest empty control).
- Render free tier is 512 MB — large repos may OOM; heap is capped.
- Generated tests are not executed.
- Team invites and ingested coverage reports are not implemented.

## Video script (≤ 3 minutes)

1. Problem (20s): PRs hide impact; chatbots invent bugs.  
2. Evidence (60s): Demo → scan → a secret/SQL finding on real fixture files.  
3. Twin (30s): Codebase map + test gap.  
4. Responsible AI (20s): explain only; apply disabled.  
5. Close (15s): working on Render. Don’t pitch — prove it.

## Local run

```bash
npm install
cp .env.example .env.local
# SESSION_SECRET = any 32+ character string
npm run dev
```

http://localhost:3000 → Explore Demo → Run scan. Tests: `npm test`.

## License

MIT.
