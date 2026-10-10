# Renderer selection and authentic demonstration

This skill is an **agent-directed workflow**, not a mandatory dependence on Hyperframes. Choose tools matching the actual requested visual, keep the accepted source editable and record what was really rendered.

## Renderer decision

| Visual output                                                          | Primary mode                                                                                | Required proof                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Typography, diagrams, charts, architecture flows                       | Deterministic local HTML/CSS/SVG/Canvas and `render.mjs`                                    | Exact seek, no drift, accessible fonts, frame data and layout                                 |
| Product UI, cursor actions, web app use                                | Reuse actual authored HTML/CSS/components; deterministic time-driven UI in headless browser | Actual UI source and visible entry → action → result; auth-safe/redacted captures             |
| CAD/DCC scene, spatial animation, geometry or native material/lighting | Native Blender (or owner-approved equivalent native DCC), offline/isolated headless render  | Actual .blend, keyframes/geometry/nodes, native engine/build, distinct frame snapshots/reopen |
| Real browser/software walkthrough that cannot be deterministic         | Approved controlled screen recording with timestamps and private content masking            | Source software build, actual interaction trace, no secret exposure, truthful replay          |
| Hybrid                                                                 | Approved mix of the above, with shot-specific source provenance                             | Separate native/browser/recording QA, consistent ratio/cadence, reproducible edit             |

The HTML render contract in [contract.md](contract.md) applies **only to that engine**. Do not claim a Blender-native deliverable because CSS simulates camera motion. Do not claim `window.video.render(t)` validation for a real recorded screen or native DCC shot.

## Native safety

- Never open/save over the owner's active, dirty Blender scene. Copy into a fresh versioned job. Run with isolated profile / `--factory-startup` where qualified. Do not install/change the user's addon, mutate Gateway provider config, OAuth/auth, or launch visible CMD windows as an unnoticed side effect.
- Verify source-native operation in the supported DCC version. For Blender, inspect saved blend after reopen in an independent session: expected objects, keyframes, timeline, GI/render settings, Geometry Nodes modifiers and sampled animated values.
- Require _native_ motion if promised: camera/object/material/particle keyframes or GN animation changing over multiple sampled frames. A static render moved/zoomed in post must be labeled as image motion, **not native animated scene**.
- Always render settled styleframes before committing hours of GPU work. Estimate total frame count, render time, storage and contention. Use bounded chunking and explicit output manifests for resumable jobs, check every index exactly once before encoding. Stop when owner rejects design.
- A separate compositor can assemble native shots, but must preserve frame rate, duration, audio and color treatment across shots. Claims must distinguish native render resolution from final encoded resolution.
- If requested native software is not ready (Blender UI closed, CAD bridge offline, provider not qualified), state that and use available _real previously accepted_ artifact or seek permission. Do not falsify a tool invocation or outcome.

## Privacy and promotion

- Use sanitized demo-only accounts/workspaces for product capture. Blur/redact file paths, usernames, credentials, tokens, host IPs and secrets before any owner-visible/public deliverable.
- Assets downloaded from third parties require license documentation. Never run arbitrary project code, install a new tool or send private repo materials to a SaaS just because a video generation workflow suggests it.
- `/brag` has a Hyperframes path; here it is **optional** and usable only if installed separately with owner authorization. There is no need for external services to write local deterministic or Blender-native videos.
- Production deployment, Git tags, and publication do not follow from approval to create a video. Record permissions separately.
