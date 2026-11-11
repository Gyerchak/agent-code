---
title: Local models (Ollama)
summary: How to get usable results from models running on this machine.
---

How to get usable results from models running on this machine.

- **Context size decides everything.** Ollama loads models with a small default context (often 4K tokens); a coding agent's instructions alone need ~20K. Agent Code creates a variant sized to the GPU automatically; elsewhere set `num_ctx` in a Modelfile (`FROM <model>` + `PARAMETER num_ctx 65536`).
- **Stay on the GPU.** `ollama ps` shows how much of the model is in VRAM. Anything below 100% runs partly on the CPU and gets many times slower: pick a smaller model, a smaller quantisation, or a shorter context.
- **Check the build.** A CPU-only Ollama package shows `total_vram=0` in its log; install the CUDA/ROCm build for your GPU.
- **Useful server settings** (systemd drop-in or environment): `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0` (halves the context's memory), `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_KEEP_ALIVE=30m`.
- **Size expectations.** Small models (≤4B) handle search, summaries and simple edits; 8–14B models manage routine coding; complex multi-step work still needs a large cloud model.
- Capabilities (tools, vision, thinking) are fixed by each model file; there is no switch to add them.
