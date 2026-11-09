---
title: Math notation in HTML
summary: A working reference for putting math on a web page.
---

A working reference for putting math on a web page.

## Characters that cover most secondary-school math
`× ÷ ± ∓ ≠ ≈ ≤ ≥ < > √ ∛ π τ θ α β γ Δ Σ Π ∫ ∂ ∞ ° ‰ ² ³ ⁴ ₁ ₂ ₃ ₙ ₓ ∈ ∉ ⊂ ⊃ ∪ ∩ ∅ ∀ ∃ ¬ ∧ ∨ → ↔ ∴`

## Structure
- Fraction: inline-grid with two rows and a border under the top row.
- Exponent/root: `<sup>`/`<sub>`; roots as `√` + overlined argument or KaTeX.
- Equation systems: a `<table>` or grid with aligned `=` (CSS `grid-template-columns`).
- Number formats: keep the exact form the subject uses (fractions in Poland stay fractions;
  decimals with a comma in Polish text, a dot in code).

## Rendering engine choice
| need | choice |
|---|---|
| plain text, one-liners | Unicode (no dependency) |
| real typesetting, fast | **KaTeX** (render from stored TeX at display time) |
| zero dependency, modern browsers | MathML (support still uneven) |

## Rules
- Store the source (TeX/plain), never the rendered HTML — re-render on display.
- Check answers by normalising to a canonical form (rational/float with epsilon), not by strings.
- Every formula gets a plain-language gloss for the learner ("the area of a circle").
