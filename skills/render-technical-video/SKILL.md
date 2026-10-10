---
name: render-technical-video
description: >-
  Plan, design and render evidence-led technical explainers, app/product launch
  films and native CAD/DCC demos. Inspired by /brag with a two-second hook,
  authentic product use, storyboard and approved styleframes before full rendering.
  Includes deterministic HTML/Canvas capture, native Blender and honest delivery QA.
---

# Render technical video / product launch film

Make a film that **shows what the actual project does**. Technical accuracy, clear storytelling,
legible motion and the owner's visual approval matter more than a successful encoder exit code.
This workflow borrows creative methods from [latent-spaces/brag](https://github.com/latent-spaces/brag);
it does **not** depend on Hyperframes, copy /brag's assets or authorize uploading private source.

## 1. Identify the input, audience and deliverable

Read the real source first: README, supported tools, product UI/components, approved screenshots,
data, work sessions and existing video assets. Prefer verifiable **entry → action → result**
over abstract boxes, generic network/neon motion or fabricated numbers. If no real examples
are accessible, say so, plan an explicitly **illustrative** shot, and do not imply native proof.

Choose the mode:

- **Technical** — accurate mechanism, data/units, diagrams, simulations or architecture.
- **Launch/demo** — a /brag-like hook, product-in-use, two or three strongest results, brand outro.
- **Hybrid/native** — factual footage from a real approved Blender/CAD/DCC scene or authorized
  app interaction, with an editorial composition wrapper.

Ask for 16:9 or 9:16 **unless this particular video already has an explicit ratio**;
never infer the aspect ratio. Confirm or infer audience, takeaway, duration, language, tone,
final format, soundtrack rights and whether narration is requested. Honor specified duration
and quality (e.g. an already agreed 45s/1080p/30fps master). For an unspecified short launch
film suggest **15–25s** (often ~20s); this does not override longer commissioned videos.
For unspecified resolution/fps, prefer native **3840×2160 or 2160×3840 at 60fps**
subject to owner confirmation and measured host capacity; do not silently lower final quality.
A lower-resolution design/preview cut must be labeled as such.

Technical mode defaults to silent video with captions when audio is unspecified.
For launch mode **propose** an appropriate music bed and restrained interaction SFX;
only use authorized original/licensed audio. Voiceover is opt-in, never automatic.
Read [audio.md](references/audio.md). Do not invent product performance or access claims.

## 2. Inspect, plan and storyboard (/brag-inspired)

Read [creative.md](references/creative.md) and [design.md](references/design.md).
Copy [the film plan template](assets/plan-template.md) into the isolated job as `plan.md`; answer the nine source/identity/audience/visual-hook/actual-flow questions.
Write `composition-brief.md` with an exact timeline and scene table:
**time interval, claim, factual source, on-screen text, interaction/motion, entrance,
settled reading hold, exit/transition and sound cue**.

A launch film should open with a compelling **first two seconds**, show a real UI or action
before generic feature callouts, and end with a clear memorable conclusion.
A technical film should lead with the question, explain the mechanism and finish with
sourced measurements/results. In both, keep 2–3 highlights and eliminate filler.

Text intended to be read needs roughly **0.3 s per word** after it is fully settled;
short labels ~0.8s, headlines at least ~1.2s. Count animation entrance/exit **separately**.
Never rely on transition flashes for readability. Source colors, typography and graphics
from the real product rather than cloning another brand's visual identity.

## 3. Design approval gate — before any long render

**Always create a fresh isolated/versioned job.** Save three or more settled styleframes:
**opening hook, real action/technical proof, final end-card**. Produce a short **3–8s**
animated proof containing a representative cut/transition and inspect it in motion.

Look at actual full-size images and the encoded prototype, not only hashes, screenshots
of tiny contact sheets or ffprobe. Check typography, safe margins, legibility, UI provenance,
mechanism accuracy, scene boundaries, audio, color and whether the first two seconds hook.

**Show these to the owner and wait for visual direction approval before a long/full render.**
If the owner explicitly waives this gate, record the waiver and proceed. This protects
against spending hours rendering a technically passing but aesthetically rejected video.
Preserve previous takes; stop any abandoned vN render/auto-finalize jobs rather than
letting them continue to consume owner hardware.

## 4. Choose the actual rendering engine

Read [production.md](references/production.md) and, for HTML/Canvas,
[contract.md](references/contract.md). Use tools **already authorized and available**:

**A. Deterministic HTML/CSS/SVG/Canvas (default for diagrams, UI and kinetic type).**
Start from `assets/template.html` and `assets/fonts/` inside an isolated job.
Implement `window.video.meta`, `window.video.ready` and `window.video.render(t)`,
where all visible state depends on absolute `t` seconds. Await decoded fonts/images;
use seeded stable-object animation, reset Canvas/DOM on each seek; accept reverse/repeat
seek and never advance via real-time timers, requestAnimationFrame or unbounded CSS
animations. Render from authenticated/local authored assets only; keep external requests
blocked. Maintain exact stage bounds at DPR 1, no cropped content, bars or overflow.
Never use this Chromium renderer for hostile/unreviewed JS.

**B. Native Blender/DCC (when real 3D/geometry/software operation is the requirement).**
Save an **independent** scene, keep native camera/object/Geometry Nodes keyframes and
prove differences at sampled frames after reopen. Use the supported native version and
isolated profile; do not touch the owner's active scene, running addon/Gateway/auth or
open CMD windows as a side effect. A CSS camera effect or still-frame pan is _not_
native Blender animation. Give separate native proof, version and render statistics.

**C. Actual software recording** — use only approved/sanitized UI capture; label
demonstrations/illustrations accurately and redact host/user/credential details.

## 5. Render/QA (HTML mode)

Requires Node 22.13+ with built-in WebSocket, Chromium/Chrome, ffmpeg/ffprobe.
Use an available compatible runtime; do not mutate gateway dependencies.
`VIDEO_BROWSER` overrides browser auto-detection. Keep Chromium sandbox enabled.

```bash
node skills/render-technical-video/scripts/render.mjs --preflight
node skills/render-technical-video/scripts/render.mjs /absolute/job/work/scene.html /absolute/job/preview-v1 --preview
node skills/render-technical-video/scripts/render.mjs /absolute/job/work/scene.html /absolute/job/render-v1
```

Read [linux-runner.md](references/linux-runner.md) if browser sandbox cannot start
inside a hardened service; do not defeat the sandbox. Each output directory must be new.
This renderer's `video.mp4` is **silent H.264/yuv420p** and
`render.mjs` does not synthesize or mux audio. Output frame indices are 0...N-1,
with N=duration×FPS; no duplicate endpoint. Review `contact-sheet.jpg` and
full-size `preview-*.png` for starts/middles/ends/transition boundaries and run
repeat/reverse/delayed-capture consistency gates. Browser/asset failure must be fatal.

For final packaging after design approval, read [delivery.md](references/delivery.md):

```bash
node skills/render-technical-video/scripts/package.mjs /absolute/job/render-v1 /absolute/job/final \
  --poster-frame 180 --share-copy /absolute/job/share-copy.txt
```

Optional authorized audio:

```bash
node skills/render-technical-video/scripts/package.mjs /absolute/job/render-v1 /absolute/job/final \
  --poster-frame 180 --share-copy /absolute/job/share-copy.txt \
  --audio /absolute/job/approved-score.wav --audio-credit "Original soundtrack for this film"
```

The package tool selects an explicitly chosen **settled** poster, embeds it in frame 0
without increasing duration, optionally muxes the supplied audio, and verifies the export.
It **never** downloads music or requests external account access.

For native/composite modes use equivalent QA appropriate to those tools, and do not
claim HTML reverse-seek determinism if it was not tested. Do not claim "native 4K"
for an upscaled diagnostic render. For long jobs estimate CPU/RAM/disk/encode
time first; use bounded single-worker execution unless evidence justifies concurrency.

## 6. Delivery and acceptance

Read [quality.md](references/quality.md) and [delivery.md](references/delivery.md).
Record three **independent** statuses:

- **Factual/provenance:** claims, UI, model/data, access permissions, privacy and sources.
- **Creative/visual:** owner-approved look, inspected full-size stills, action legibility,
  scene timing, transitions, soundtrack and strong poster.
- **Technical/export:** codec, dimensions, pixel format, fps, frame count/duration,
  full decode, audio presence/levels/sync, hashes and runtime identity.

Deliver video, poster, 1–3-sentence specific share copy (for launch mode), editable
source/assets, scene plan, shot/asset provenance, QA report and exact limitations.
Capture Node/Chromium/Blender/OS/FFmpeg build versions; source/template/asset/video
SHA-256 fingerprints, elapsed time and mean/p95 capture latency where applicable.
Technical success **does not** constitute creative approval. Never claim "final"
until every applicable gate has passed.

For fair model/tool comparisons, fix brief, sources, exact resolution, runtime,
tools, visual-review budget, time/cost and revision count; score design and
technical correctness separately and retain failures. Output creation alone
does not authorize uploading, deploying, tagging a release or publishing content.
