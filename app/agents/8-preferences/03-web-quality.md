---
title: Web quality
summary: For web work, in this order
---

For web work, in this order:
1. No runtime dependencies; a single folder that runs by opening `index.html`.
2. Semantic + accessible markup (real controls, labels, keyboard, `aria-live` for results).
3. Responsive from 320 px, no horizontal scroll, no layout shift; print stylesheet if it
   produces paper (cheat sheets).
4. Dark/light via `prefers-color-scheme` + a stored override.
5. Offline-capable by default; state in `localStorage` with a version + export/import.
6. Measured before claimed: open it in a real browser with the console clean, test the core
   logic headlessly, keep the numbers.
