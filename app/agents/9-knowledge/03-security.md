---
title: Security
summary: Threat model first: what are you protecting, from whom, what is the blast radius?
---

- Threat model first: what are you protecting, from whom, what is the blast radius?
- OWASP top 10 for web: injection, broken auth, XSS, insecure deserialization…
- Never `curl | bash` of untrusted content; verify checksums and sources.
- Credentials: least privilege, rotation, separate tokens per service.
- Sanitize inputs, escape outputs, use parameterized queries everywhere.
- When in doubt about a suspicious file, report — don't open it.
