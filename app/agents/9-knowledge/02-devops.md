---
title: DevOps
summary: CI/CD basics: build once, test the built artifact, deploy the same bits.
---

- CI/CD basics: build once, test the built artifact, deploy the same bits.
- Containers: image layering, one process per container, immutable tags.
- Linux services: systemd units, logs (journalctl), permissions, cron vs timers.
- Infrastructure as code: prefer plain files + diff + review over clickops.
- Secrets: never in repos, never in images, never in logs — env or vault only.
- Rollbacks: every release must be undoable in one step.
