---
title: Satirical AI art (Azerbaijan Technology style)
summary: Luca Maxim (Luca Maxim Khocholava — Georgian artist/musician from
---

## Who & what

Luca Maxim (Luca Maxim Khocholava — Georgian artist/musician from
Tbilisi, raised in the Netherlands; Instagram @lucamaxiim, TikTok @santeluca,
YouTube "Luca Maxim", merch brand "Children of Khan") built a satirical
fictional universe around "Azerbaijan Technology" — a fake tech company that
parodies corporate culture, tech worship and internet trends. It's repeatedly
called "the best use of AI ever" because the uncanny, imperfect nature of AI
output IS the art. He now teaches his method in a paid course, "Elite Ball
Knowledge" ($197, private Skool community). Use this playbook to make
"absolutely fire" content in the same spirit (maxxim energy).

## The aesthetic — "AI Slop", done on purpose

The look is high-saturation, glowing, surreal and deliberately "off":
- Oversaturated colors, glowing machinery, clean product-render surfaces
- Distorted / uncanny faces and bodies — AI's "mistakes" are a feature
- Surreal juxtapositions: futuristic tech + mundane/shrimp/agriculture
- Corporate infomercial / ad aesthetic, played completely dead-straight
- Post-irony: low-effort "slop" used as high-concept satire

## The lore (reuse and extend it)

- Azerbaijan Technology: a hyper-futuristic fictional company
- HQ in Agartha (hollow-Earth); 100% internet access via Agartha
- CEO "Uncle Uncle"; compliance divisions; sentient shrimp
- EuroShrimp units (genetically-enhanced boy band / shrimp farming)
- Microwave hoverboards, Yakubian science, a 2046 timeline
- The joke: Real Azerbaijan + real fuzzy-logic history + real shrimp
  farming + absurd invented lore, all treated with a straight face

## The method — how he actually makes it (Elite Ball Knowledge)

The course teaches the system, not tool tricks ("not a tutorial on tools").
The public framework + his own interviews reveal the method:

### The 3 steps
1. Find concepts that earn attention — turn raw references into ideas with a
   Reason to be watched.
2. Build visual worlds with consistency — imagery/video that looks deliberate
   from the first frame to the last.
3. Write stories that hold attention — a repeatable scripting structure built
   for short-form retention.

### The pipeline (per video)
raw idea → narrative structure → scene logic → prompting → final output.
Never prompt a whole video in one shot — structure it scene by scene first.

### The principles (why his AI output is better than "slop")
- "Taste can't be automated" — human insight and creativity are the real
  filter; the model's output is only ever raw material.
- Research-first satire: genuinely study the target culture/trend before
  parodying it — the joke is built on real knowledge, not a funny prompt.
- The uncanny is deliberate: AI's errors (morphing faces, impossible
  geometry) are kept and amplified on purpose — the flaw is the feature.
- Co-create cheaply: fan ideas become content, and AI makes trying them
  nearly free ("not spending resources on trying those ideas").
- Consistent brand voice: one fixed world (Azerbaijan Technology); every
  video is a new room in that world, not a new universe.
- The human is the artist, AI is the instrument — vision and taste are his;
  tools only accelerate.

## Creating it with the local stack

### Images (ComfyUI — FLUX.2 klein 9B & 4B / FLUX.1 dev / SD1.5)
Prompt recipe:
- Style keywords: "high saturation, surreal, uncanny, glowing, corporate
  advertisement, product render, oversaturated, slightly distorted"
- Subjects: futuristic machinery, shrimp farms, hoverboards, distorted CEO
  portraits, corporate logos, Agartha interiors
- Stay dead-serious — the humor is the juxtaposition, not the prompt
- FLUX for clean text/logo rendering (key for the corporate satire);
  SD1.5 for painterly/uncanny texture
- Low CFG (FLUX ~3.5); let it be a little "off" on purpose
- Pick by need: FLUX.2 klein 4B for fast sketching, klein 9B as the daily
  driver and the current quality ceiling (FLUX.2 dev 32B was purged).

### Video (AnimateDiff / LivePortrait / RIFE — no Wan/H3 on this card)
- 2026-08-23 purge: Wan 2.2 ×4, MiniMax H3, LTX, Qwen-Image removed — no
  video-diffusion model fits the 3060 anymore. Animate via:
  - AnimateDiff (SD1.5, `animate-sd15`) — real motion on stills
  - LivePortrait (`liveportrait-talking`) — talking/distorted faces
  - RIFE (`video-upscale-rife`) — slow cinematic push-ins on a FLUX still
- Generate 2–10s clips: corporate infomercial segments, surreal factory
  tours, shrimp farms, hoverboard demos, distorted spokespeople
- The "AI video" look (uncanny motion, morphing faces) is desired
- Image-to-motion: feed a FLUX/SD1.5 still and animate it (all silent —
  mux audio afterwards)

### Music (demucs stems + Kokoro; text→music engine not installed yet)
- Stable Audio Open / AudioLDM2 model files were purged 2026-08-23 (engines
  were never wired) — today: build beats from demucs-separated stems /
  synths, voice via Kokoro/Chatterbox
- Hypnotic, distorted, futuristic beat — future-bass / Jersey-club energy,
  ~123 BPM, a looping "Azerbaijan Technology" vibe

### Voice (Kokoro / Chatterbox)
- Deadpan corporate "infomercial" voiceover, or the sung/rapped vocal

## Core principle

Lean into the uncanny. The weird AI artifacts (extra fingers, morphing
faces, impossible geometry) are exactly what makes the satire work.
Correct AI = slop; intentional AI = surreal beauty. Never smooth it out —
amplify it with intent. The fiction is dead-serious; everything else is
playful.

## Style keyword cheat-sheet
surreal, uncanny, high saturation, oversaturated, glowing, corporate,
futuristic, dystopian, product render, infomercial, deadpan, post-ironic,
shrimp, Agartha, hoverboard, hollow earth, 2046, Uncle Uncle, EuroShrimp
