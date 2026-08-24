# Two-minute demo

Repeatable path. Uses the bundled fixture and the same scanners as production.

## 0:00 — Introduce

Open the landing page. One line: *Code assistants help you write code. CodeSentinel helps you understand, protect, and verify it.*

Click **Explore Demo**. No GitHub credentials.

## 0:15 — Healthy start

Overview shows the demo fixture badge. If there is no health ring yet, click **Run scan**. Wait for the scan to finish (real scanners on `fixtures/demo-repo`).

## 0:30 — Risk appears

Point at the health score and the current risk badge. Open **Analysis**. The fixture contains real issues: hardcoded credentials, unsafe execution, Docker as root, thin tests.

## 0:45 — Guardian

Open **Guardian**. Control center: last scan, activity, recommendations. Explain that a GitHub Check reports risk; it only blocks a merge if branch protection requires that check.

## 1:00 — Blast radius + tests

Open **Codebase**. Show architecture layers and a package advisory if present. Open **Testing**. Show module linkage (not fake coverage) and a test gap on an exported symbol.

## 1:15 — AI explain (optional)

If an LLM key is set, open a finding in **Fix Center** and generate an explanation. If not: say scanners still ran; AI is optional.

## 1:30 — Fix

Stay in Fix Center. Generate a patch. Stress: **nothing is applied until you approve**.

## 1:45 — Verify

Show the suggested test. Do not claim “tests passed” unless they actually ran.

## 2:00 — Close

Back to Overview. Health and findings come from the last real scan. Demo data stays labelled **Demo fixture**.

### If something fails

- Scan error: retry **Run scan**. Check `/api/health`.
- Empty Overview: you are not in a demo session — use Explore Demo again.
- No AI: expected without `FEATHERLESS_API_KEY` / `GROQ_API_KEY`.
