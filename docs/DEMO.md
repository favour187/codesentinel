# Demo

1. Open `/` → **Explore Demo** (no GitHub keys).
2. **Run scan** — same scanners as production, on `fixtures/demo-repo`.
3. Overview: health, risk, top finding (badge: Demo fixture).
4. Analysis, Guardian, Testing, Codebase — real findings from the fixture.
5. Fix Center — explain / generate patch / generate tests. Apply to GitHub stays disabled unless the App has write access.
6. **Reset demo** wipes fixture analysis only. It cannot touch a GitHub repository.

If AI keys are missing, scanners still run. The UI says AI is unavailable — it does not invent an explanation.

Demo data is `source: 'demo'` and is never mixed with a real repo.
