---
title: Audit after change
summary: Any change to the system updates its audit in the same change, and the audit is re-run
---

Any change to the system updates its audit **in the same change**, and the audit is re-run
before the work is called done. A fix without a check is unfinished work: the next drift will
be invisible. If a check becomes obsolete, retire it (wastebin, never `rm`) and say so; never
leave a check that cannot fail.
