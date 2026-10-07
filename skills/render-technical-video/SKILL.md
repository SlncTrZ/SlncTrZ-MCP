---
name: render-technical-video
description: Create technical infographic videos with HTML, CSS, JavaScript and Canvas, then capture deterministic frames in headless Chromium and encode with FFmpeg. Use for animated technical explainers, diagrams, data charts, architecture videos, or requests for web-code-to-video and frame-by-frame rendering. Includes storyboarding, seekable render(t), visual review and reproducibility checks.
---

# Render technical video

## Establish the brief

Read the actual project, data and existing video helpers before creating anything. Follow the owner's write approvals and project instructions. Keep host addresses and credentials out of this reusable skill; load the owner's separate host skill when remote execution is needed. Verify the execution host and installed tools.

Confirm or infer audience, one takeaway, duration, language and whether narration is requested. Before storyboarding or rendering a requested video, ask the owner to choose 16:9 or 9:16 unless that specific video already has an explicit choice; never infer the aspect ratio. Prefer native 4K at 60 FPS: 3840×2160 for 16:9 or 2160×3840 for 9:16. Do not lower resolution or FPS without the owner agreeing; clearly distinguish lower-resolution diagnostic previews from the final deliverable. Default to silent video with captions when audio is unspecified. Label synthetic data as illustrative. Preserve units, sources, axis baselines and comparisons; never invent product performance claims.

Create a scene table before code: time range, message, exact text/data, visual, entrance, hold and exit. Allocate readable holds. Read [design.md](references/design.md) for motion, layout and chart guidance. Use one consistent palette, type scale and spacing system; derive scene timing from one source.

## Build the page

Start from `assets/template.html` plus its `fonts/` folder in an isolated job directory. The bundled 4K/60 landscape example does not select a ratio for the owner; use it only after the ratio question is resolved and redesign the composition for portrait when chosen. Edit the scene content and metadata together. Read [contract.md](references/contract.md) before changing the renderer interface.

- Fill the entire chosen frame. Match the viewport, stage CSS bounds and Canvas backing pixels to the output dimensions at DPR 1. Set html/body margin and padding to zero, overflow hidden, and Canvas display block. Do not capture browser chrome, scrollbars, letterboxing or a cropped oversized page; reflow the layout for portrait instead of cropping the landscape design. Review all four edges and fix overflow rather than merely hiding lost content.
- Expose `window.video.ready`, `window.video.meta`, and asynchronous or synchronous `window.video.render(t)` with time in seconds.
- Make every visible property a function of absolute time. Reset Canvas transforms/state and clear each frame. Derive particles from stable object IDs/seed and time, never a stateful random sequence or accumulated delta.
- Permit arbitrary seek order. Do not use real-time timers, animation loops, autonomous CSS transitions, live video, animated GIFs or network data in export mode. Paused Web Animations may be sought explicitly inside render(t).
- Await required font faces, image decoding and any asynchronous draw before returning. Readiness is a contract, not a sleep. Fail on missing assets rather than exporting fallback text or blank frames.
- Keep render(t) independent of capture speed. Overriding Date.now/performance.now alone does not control CSS/compositor/media clocks. Use explicit timeline control.
- Keep dependencies and assets local. Use trusted authored pages only. The helper's local server/network restrictions are not a sandbox for hostile JavaScript.

## Render and review

Use Node 22.13+ with built-in WebSocket, Chromium/Chrome, ffmpeg and ffprobe. Reuse an available compatible runtime; do not modify the gateway package dependencies. Choose a browser via `VIDEO_BROWSER` or auto-detection. Keep the Chromium sandbox enabled; do not add no-sandbox to make a failure disappear.

```bash
node skills/render-technical-video/scripts/render.mjs --preflight
node skills/render-technical-video/scripts/render.mjs /absolute/job/template.html /absolute/job/preview --preview
node skills/render-technical-video/scripts/render.mjs /absolute/job/template.html /absolute/job/final
```

If Chromium cannot start under a hardened Linux gateway, read [linux-runner.md](references/linux-runner.md) and use an authorized bounded user-service runner when available. An installed executable alone is not runtime acceptance.

Use a new output directory each run. The helper refuses to overwrite an existing one. Keep render artifacts outside versioned skill source. On this checkout, `_runtime/` is an ignored job location. Do not change release seeding merely to make this project skill discoverable: a project bootstrap discovers it directly.

Inspect `contact-sheet.jpg` and full-size `preview-*.png`: scene starts/middles/ends and both sides of boundaries. Check safe margins, Vietnamese glyphs, label collisions, chart correctness, transition continuity and readable hold time. Correct the page, then rerun into a fresh output directory. Do not claim visual QA from hashes or metadata alone. The helper's layout hook is not an automatic collision detector.

The helper checks repeated frames, reverse seek and a delayed repeated capture, records runtime errors and verifies the final video with ffprobe. It captures frames 0 through N−1 at i/FPS, where N=duration×FPS must be integral. It never captures an extra endpoint frame. Constant-frame-rate MP4 is silent H.264/yuv420p. For narration, first lock voice duration and align the storyboard; mux a local authorized audio file separately, then recheck streams, duration, clipping and sync. The helper does not synthesize or mux audio.

## Acceptance and delivery

Read [quality.md](references/quality.md). Require all technical gates plus human/model visual inspection. Deliver the video, editable source/assets, and report with exact limitations. Report total render time and mean/p95 capture Latency. Keep concurrency at one by default; assess CPU, RAM, disk and encoder contention before increasing Scalability. Use the measured preflight estimate to budget long renders.

Use SHA-256 Fingerprinting for source/assets/helper/video and record browser, Node, OS and encoder versions. Byte-identical frames are only expected within a pinned rendering environment; font rasterization and codecs can vary across platforms.

For model comparisons, use the same brief, datasets, harness, resolution, tool/vision access, time/token budget and revision count. Score technical correctness and visual quality separately; retain failures and avoid selected-demo comparisons or unverified model rankings.
