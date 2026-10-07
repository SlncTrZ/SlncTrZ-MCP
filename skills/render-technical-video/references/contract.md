# Page and capture contract

Expose window.video before the page load event completes:

```js
window.video = {
  meta: {
    width: 3840,
    height: 2160,
    fps: 60,
    duration: 15,
    seed: 20261006,
    scenes: [
      { name: "Problem", start: 0, end: 5 },
      { name: "Mechanism", start: 5, end: 10 },
      { name: "Result", start: 10, end: 15 }
    ]
  },
  ready: initializeAssets(),
  render: async (t) => {
    /* draw complete scene from t */
  },
  validate: () => [] // optional: return current layout/data errors
};
```

- Ask for 16:9 or 9:16 before choosing dimensions unless the owner already specified that video’s ratio. Prefer 3840×2160 or 2160×3840 respectively, at 60 FPS; get agreement before downgrading final quality. The example above is landscape, not permission to assume the ratio.
- Use even width/height, 320–3840 and 180–3840 respectively, with at most 8,294,400 pixels per frame. DPR is fixed to 1. Render Canvas at those backing dimensions; scale vector design coordinates explicitly, never upscale a low-resolution raster export.
- Fill the viewport exactly: html/body width and height 100%, margin/padding 0, overflow hidden; Canvas display block. The renderer applies a fixed root frame and rejects document overflow, visible nested scrollbars or mismatched #stage bounds/backing pixels. Keep intentional offscreen animation inside a clipped stage container; inspect all four edges so overflow hiding cannot mask missing content. Reflow portrait layouts rather than stretch or crop landscape content.
- Use integer FPS 1–60 and duration >0 up to 600 seconds; maximum 18,000 frames. Require duration×FPS to be integral. These are resource bounds, not quality recommendations.
- Require 1–100 contiguous, non-overlapping named scenes covering [0,duration]. Intervals are half-open. At a boundary t, the incoming scene owns that time.
- Derive scene starts/ends and transitions from metadata. Crossfade using deterministic local times and include both visual layers explicitly. Never advance a hidden scene counter.
- Resolve ready only after required font loads are nonempty and every image has decoded. Await lazy assets inside render(t). Reject on failure.
- Return from render(t) only when drawing is complete. The runner awaits its promise then captures Chromium's surface. No requestAnimationFrame is required to advance time.
- If using DOM, set all visible properties every call. Explicitly pause and seek any Web Animation. The runner rejects running/pending Web Animations, but cannot prove the absence of every possible timer or media source.
- Optional validate() must return an array; use it for authored bounding boxes, overflow and data assertions. An empty array is not proof of visual correctness.
- Local HTTP assets are served only from the input HTML directory. External HTTP and WebSockets are blocked. Inline/data resources work; iframe/worker/media content is disallowed by CSP. Supply dependencies locally.

Outputs: sample PNGs, contact sheet JPEG, report.json; full mode also keeps numbered PNGs and video.mp4. A failed run has no passing report. Existing output directories are never reused. Delete old jobs only under the owner's cleanup policy.

The report fingerprints requested assets and renderer source, records environment versions, sample hashes, estimated duration, Latency and ffprobe results. Pin the full environment for cross-run comparisons. For resumed/chunked jobs, add explicit manifests and verify every index exactly once; this helper intentionally exports one bounded sequential job.

Protocol references: [Runtime.evaluate](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-evaluate), [Page.captureScreenshot](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot), [Emulation.setDeviceMetricsOverride](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setDeviceMetricsOverride), [FFmpeg image2](https://ffmpeg.org/ffmpeg-formats.html#image2-1).
