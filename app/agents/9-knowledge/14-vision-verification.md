---
title: Vision verification
summary: Vision models describe what a logo "should" look like; the pixels are the evidence.
---

Vision models describe what a logo "should" look like; the pixels are the evidence.

## The rule
A vision-model claim about an image is a hypothesis, never evidence. DeepSeek vision-exp invented
timestamps, saw text on a blank tile, and called a correct mark a "hexagram". Local Ollama models
(`qwen3.5:9b`, `moondream`) are a second opinion, not a judge.

## Pixel ground truth (PIL/numpy)
- non-white mean RGB · black-pixel count · quantized colour histogram · dominant/hex colours
- content bounding box → cropping (content touching an edge) and centring offset
- alpha/corner checks · connected-component count
- **ASCII luminance map** — authoritative for shape; render it before believing any shape claim
- rotation: brute-force angular match against the upright reference
- round-trip: re-render the processed tile and compare against the official source raster

## Reading glyphs without OCR
- Crop semantic bands and inspect them separately; count glyphs by connected components.
- A dot above a glyph = "i"; a narrow trailing glyph = "r" (plain OCR read "Lumina" as "Luminar").
- ASCII-render single components to read letters directly; upscale 3× before re-running OCR.
- Cross-check against the real logo (Wikimedia Commons / vendor press kit) pixel-wise.

## Method
- Snapshot md5s first — the pipeline may regenerate files mid-audit and invalidate your sheet.
- One vision lane at a time (≤2 concurrent), then the pixel pass; keep only what pixels confirm.
- Report per file: verdict (OK / broken) + the measured numbers, never prose.
