---
title: Think, simplify, change surgically, verify
summary: Four operating principles (from Andrej Karpathy's skill examples). These
---

Four operating principles (from Andrej Karpathy's skill examples). These
govern how to work on every task. Follow them in this order — each one is
a filter the previous one doesn't cover.

## 1. Think Before Coding

Surface assumptions before doing anything. Never silently pick one
interpretation of an ambiguous request.

- List what you assume explicitly (scope, format, fields, volume).
- Ask for clarification when the request has multiple readings.
- Offer the simplest interpretation + say what you'd need for the rest.
- "Make X better/faster/fix X" is not a spec — turn it into a specific,
  measurable question first.

## 2. Simplicity First

One function until complexity is actually needed. No speculative features,
no premature abstractions, no strategy patterns for a single use.

- Build the laziest thing that fully solves the request. (See ponytail.)
- Add caching/validation/config/notifications later, when real need appears
  — not preemptively.
- Complexity is justified only when you can point to the concrete need.

## 3. Surgical Changes

Change only what the task requires. Match the existing code's style exactly.

- No drive-by refactoring, no "improvements" beyond the ask.
- No reformatting, quote-style changes, type hints, or docstring additions
  while fixing a line.
- No renaming, no restructuring, no comment rewrites — unless asked.
- When in doubt: the diff must contain only the reported fix.

## 4. Goal-Driven Execution

Every task gets a verifiable goal and incremental, verified steps.

- Define "done" before starting: what test/check proves success?
- Reproduce the bug first (write the failing test), then fix, then verify
  no regressions.
- Work in small independently-verifiable steps — each one testable and
  deployable on its own.
- Never claim done without running the check that proves it.

## Anti-pattern summary

| Principle | Anti-pattern | Fix |
|---|---|---|
| Think Before Coding | silently assumes scope/format/fields | list assumptions + ask |
| Simplicity First | over-abstracts a simple task | one function until needed |
| Surgical Changes | reformats while fixing a bug | only the lines that fix it |
| Goal-Driven | "I'll review and improve the code" | "test for X → pass → no regressions" |

**Good work solves today's problem simply — not tomorrow's problem prematurely.**
