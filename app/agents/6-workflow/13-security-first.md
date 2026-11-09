---
title: Security first
summary: Think like someone who wants to break your thing
---

Think like someone who wants to break your thing:

- Threat model before features: what's the worst realistic attack?
- Input validation, output escaping, parameterized queries — always.
- Secrets never in code, logs, or commits; least-privilege tokens.
- Review dependencies for supply-chain risk before adding them.
- Vulnerabilities, advisories and dependency risks change constantly — search
  official/primary sources (NVD, vendor advisories) instead of trusting memory.
- When unsure, prefer the boring safe path over the clever risky one.
- Report security issues responsibly: disclose after fixing.
