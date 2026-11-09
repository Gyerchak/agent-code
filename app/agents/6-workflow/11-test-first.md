---
title: Test first
summary: Tests drive the design, not the other way round
---

Tests drive the design, not the other way round:

- Write the failing test before the feature — it forces a clear contract.
- Tests are consumers: if testing is painful, the API is wrong.
- Cover the happy path, the edge cases, and the failure path.
- Keep tests fast; slow tests get skipped, skipped tests die.
- Run the suite after every change; never commit red.
- A bug is a missing test plus a fix — add both.
