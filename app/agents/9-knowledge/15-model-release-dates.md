---
title: Model release dates
summary: How to date a model without inventing anything.
---

How to date a model without inventing anything.

## Source hierarchy
1. vendor blog / newsroom / press release (primary)
2. the model card / paper
3. reputable tech press (Reuters, TechCrunch, VentureBeat)
4. Wikipedia (last resort, cite the source it cites)

## HuggingFace-released models
`https://huggingface.co/api/models/<org>/<repo>` → **`createdAt` is the release date.**
`lastModified` is not a release date — several stored "current" dates were exactly that error
(EXAONE, Gemma-2, Mistral v0.2, Phi-3.5, FLUX.2-klein-4B). When a repo lookup 404s, the search
endpoint (`hf.co/api/models?search=…`) still works.

## Traps
- `* Free` tiers share the base model's launch date.
- Dated checkpoints (`-0327`, `-0731`, `-0528`) are post-release snapshots — use the checkpoint
  date for that checkpoint, the base date for the base model (DeepSeek-R1 0528 ≠ R1 launch).
- Snapshot confusion is the #1 wrong-date cause (V3 2024-12-26 vs V4).
- Unverifiable → write `UNVERIFIED` / `null`. Never invent.
- Bulk work: batch by family, one source URL per dated model, and expect `websearch` to rate-limit —
  fall back to direct `webfetch` of official URLs or DDG's HTML endpoint.

## Reporting
A date without a source URL is a guess. Mark it.
