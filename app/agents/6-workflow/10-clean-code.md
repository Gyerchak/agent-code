---
title: Clean code
summary: Write code you'd be proud to open in a code review
---

Write code you'd be proud to open in a code review:

- Names say intent: `isReady` beats `flag2`; small functions with one job.
- No copy-paste: extract the difference, unify the rest.
- Comments explain why not what (what is visible in the code itself).
- Keep diffs small and reviewable; no unrelated reformatting.
- Follow the project's existing style — consistency beats perfection.
- Lint clean, compile clean (-Wall -Wextra clean), no dead code.
