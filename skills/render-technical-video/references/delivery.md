# Delivery, poster and publication contract

## Three distinct acceptance gates

1. **Truth and provenance:** claims/data match recorded input; real UI/commands actually exist; permission and confidentiality reviewed; illustrative portions visibly marked.
2. **Art and narrative:** styleframes and short motion sample **approved before long rendering** (unless owner waives); visual inspection of final output; first two seconds work without narration; no illegible type, scene collision or generic filler.
3. **Technical:** full encode decodes; dimensions/FPS/frame count/duration match the commissioned format; no dropped/duplicate/missing frames; audio sync/peaks checked; SHA-256/environment/provenance recorded.

Passing gate 3 **does not mean** gate 1 or 2 passed. Report them separately and do not call unreviewed work "final".

## Files in a fresh versioned job

- `plan.md`: product/topic, evidence, nine-question creative rubric, actual source links, ratios/duration/quality, mood.
- `composition-brief.md`: exact scene/beat table, graphics, typography, safe zones, storyboard, asset inventory, transition and audio cues.
- `work/`: local copied assets, source app snippets (redacted), authoring page or native .blend/scene, styleframe renders, sound stems, temp/frames, logs.
- `styleframes/`: settled first hook, real action / measured proof, strongest outro, with an optional storyboard contact sheet.
- `motion-proof.mp4`: inspected short prototype, typically 3–8 seconds (separate from master).
- `final/`: `launch.mp4`, `poster.jpg`, `share-copy.txt`, `delivery-report.json`. Technical films may use a project-specific title instead; record exact path.

Retain production source/editability in the job, not just video and screenshots. Reuse real UI/video assets, not static-screen pan simulations for a product that has interactions. Never modify the user's active scene, installed addon profile or output of a previous approved iteration without explicit permission.

## Deterministic HTML/Canvas mode

After source and style approval:

```bash
node skills/render-technical-video/scripts/render.mjs --preflight
node skills/render-technical-video/scripts/render.mjs /absolute/job/work/scene.html /absolute/job/preview-01 --preview
node skills/render-technical-video/scripts/render.mjs /absolute/job/work/scene.html /absolute/job/render-01
node skills/render-technical-video/scripts/package.mjs /absolute/job/render-01 /absolute/job/final --poster-frame 180 --share-copy /absolute/job/share-copy.txt
```

The helper `render.mjs` remains a **silent deterministic** HTML/Canvas engine. It emits `video.mp4`, `frames/*.png`, `contact-sheet.jpg`, `report.json`. It is not Hyperframes and does not capture a native Blender scene. The package helper extracts the **explicitly selected settled frame** as `poster.jpg`, places that image on frame 0 without increasing the frame count/duration, optionally muxes an already authorized soundtrack, verifies the resulting MP4 and writes a reproducibility manifest.

Optional audio:

```bash
node skills/render-technical-video/scripts/package.mjs /absolute/job/render-01 /absolute/job/final \
  --poster-frame 180 --share-copy /absolute/job/share-copy.txt \
  --audio /absolute/job/approved-score.wav --audio-credit "Original soundtrack composed for this job"
```

Use **only** a source you are allowed to redistribute. `--audio-credit` is an attribution/provenance statement, not proof of a license. If no authorized audio exists, deliver a silent video and say so. Narration requires owner opt-in. If explicit owner instruction requires an audio workflow the helper cannot provide, work out approval and bounded tools first rather than claiming it rendered automatically.

### Poster policy

Select a **fully settled compelling frame** (never arbitrary frame zero / transition frame); show it during the style review. The package helper verifies that this frame exists and uses it as `poster.jpg` and frame 0 of `launch.mp4` without adding a frame. Do not substitute an unrelated cover graphic. Compare poster with decoded frame 0 as a final visual check.

### QA record

Final report must distinguish `render-report.json` from the packaged `delivery-report.json`, and list: video/poster hashes, dimensions, FPS, frame count, duration, audio codec/presence, source and template fingerprints, browser/Node/ffmpeg or Blender native identity, time budget, measured time, still/frame visual inspection, license/source list, known limitations and owner review status. Never claim "native 4K" for upscaled frames.

## Native Blender and screen recordings

See [production.md](production.md). They require separate mode-specific native/UX evidence, actual frame extraction and equivalent final QA; `render.mjs` checks do not carry over magically. Keep credentials and running user profiles untouched.

## Share copy

One to three concise sentences specific to the demonstrated product and outcome, not boilerplate "Excited to share..." or invented benchmarks. `share-copy.txt` should contain only public information approved for sharing.

**Publication is a separate permission boundary:** delivering a file does not authorize posting it, deploying a gateway, copying secrets, changing auth or publishing to a third party.
