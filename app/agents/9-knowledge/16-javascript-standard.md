---
title: JavaScript standard
summary: The engineering standard he chose, for plain modern JavaScript (ESM, no TypeScript)
---

The engineering standard he chose, applied to plain modern JavaScript (`.js` / `.jsx`, ES modules).

## The core split
- **Serving code** (anything a user waits on): degrade one feature at a time, return `{ ok, value, error }`
  results, never break the session, never let an exception cross a boundary.
- **Operator code** (CLI, jobs, tooling): fail fast, non-zero exit, loud logs.
- Every file says at the top which domain it is.

## Non-negotiables
- 100-column lines · 4-space indent · ES modules only (`import`/`export`), `"use strict"` semantics.
- **Zero runtime dependencies** in core code.
- No implicit globals, no `var`, no `==` (use `===`), no prototype patching, no `eval`.
- Validate inputs at module boundaries instead of trusting their shape; JSDoc on exported functions
  when the shape isn't obvious.
- Big-endian unit names: `latencyMillisecondsMax`, not `maxLatencyMs`.
- No default parameters; every library option passed explicitly.
- Small plain objects and tagged objects (`{ kind: "…" }`) over boolean flag bags.
- Comments short and simple; rule IDs (`JS-nn`) stay citable in review.

## Auditing a repo against it
Read the repo's own AGENTS.md/architecture first, map its rules to `JS-nn`, then grep mechanically
for breaches (`var `, ` == `, `eval(`, `?? <literal>`, `?.` chains ≥2, >100-col lines, `console`,
implicit globals), and finish with the real gate (build / `node --check` / lint / tests).
Report pass/fail counts, never impressions.
