# Demo

## Proof of Possible 2026 (judges)

Live: https://codesentinel-3yg4.onrender.com/?judge=1  
Don’t pitch — run the demo. Full pack: [`PROOF-OF-POSSIBLE.md`](./PROOF-OF-POSSIBLE.md).

## 30-second pitch

Code assistants help you write code. CodeSentinel is an autonomous **guardian** for a GitHub repository: it scans real files, maps how a change can spread, explains findings with optional grounded AI, and never applies a fix without review.

## 2-minute path

1. Open `/` → **Explore Demo** (no GitHub keys).
2. **Run scan** — same scanners as production, on `fixtures/demo-repo`.
3. Overview: health + risk + top finding (badge: Demo fixture).
4. **Analysis** / **Guardian** / **Testing** / **Codebase** — real findings, events, test gaps, architecture.
5. **Fix Center** — explain / generate patch / generate tests. Apply to GitHub stays disabled unless the App has write access.
6. **Reset demo** to repeat from a clean scan.

Optional: add `?judge=1` for a shortcut bar (Health, Guardian, Findings, Impact, Tests, Fix).

If AI keys are missing, scanners still run. The UI says AI is unavailable — it does not invent an explanation.

## Technical

Deterministic scanners + digital twin first. LLM is optional and evidence-bounded. Webhooks verify HMAC. Demo data is `source: 'demo'` and cannot be mixed with a real repo.

## Highlights

Guardian · twin / blast radius · test intelligence · secret redaction · explicit approval · works without AI.
