---
title: Design asset pipeline
summary: How the TierMaker/logo work was done, generalized.
---

How the TierMaker/logo work was done, generalized.

## Tiles
- 1024×1024 fully transparent PNGs, one per model; band colours encode a tier
  (black / light-blue / blue / dark-blue / `#2B2B2B`), bands = 15 % top + bottom, 70 % logo card,
  bold centered text.
- Rasterize SVG with `rsvg-convert`; compose with PIL; keep every render reproducible from a script.

## Logo sourcing
- `raw.githubusercontent.com/lobehub/lobe-icons` (includes `*-color` variants) — the most reliable.
- HF org avatars; Wikimedia Commons for real brand marks.
- **Validate that a downloaded image is a standalone mark**: a scraper grabbed HF *page headers*
  (avatar + org name + 🤗) for 9 tiles, and one wrong org entirely. Check the image before use.
- HF social thumbnails (1200×648) have a black background baked in → luma-key them, then add the
  HF badge only on open tiers.

## Verification
Never trust a vision model's description: measure (colours, bbox, alpha, components), render an
ASCII luminance map, and compare against the official raster. Report per file: OK/broken + numbers.
