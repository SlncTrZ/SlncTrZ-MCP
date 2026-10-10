# Creative direction — /brag-inspired product and technical films

Reference: https://github.com/latent-spaces/brag (`/brag` and `/brag-slim`). Adopt **creative principles**, not their bundled media, code, brand or external Hyperframes service.

## Inspect before planning

| Input                   | Inspect                                                              | Best shot                                          |
| ----------------------- | -------------------------------------------------------------------- | -------------------------------------------------- |
| Source repo / CLI / MCP | README, actual command/API, project UI, tests, sanitized tool traces | Real request → authorized action → verified result |
| Local/hosted app        | Page/components, actual UI and brand, demo data and interactions     | App _doing_ its highest-value job                  |
| CAD / DCC / technical   | Approved model/scene, specs, snapshots, verified operation           | Authentic native work and measured before/after    |
| Dataset / explainer     | Primary sources, units, transforms, baselines, methodology           | Accurate question → mechanism → answer             |

Answer these **nine questions** in `plan.md`: (1) What is it? (2) For whom? (3) What makes it demonstrably distinctive? (4) What single takeaway? (5) Which _real_ assets and source paths are usable? (6) What catches attention within 2 seconds? (7) Which two or three actions/results matter? (8) Which authentic colors, fonts, tone? (9) What entry → action → verified result can be shown?

If a product has a working user flow and the proposed middle is merely floating shapes or generic technology icons, **reject and redesign that storyboard**. Do not invent features, testimonials, performance figures, capability/support status, OAuth approval or successful tool output. Watermark illustrative/mock UI **in the frame** and record its provenance. Do not expose tokens, private file paths, addresses or unredacted owner UI.

## Story structure

**Launch film** default planning duration is **15–25s** (~18–22 works well) _only when not otherwise specified_. Arc: **2s hook → product reveal → 2–3 concrete demonstrations → punchy ending**. An explicitly commissioned 45s film remains **45s**; offer a 20s social edit as an additional artifact, not an unapproved substitute.

**Technical explainer**: one precise question → diagram/chart/model showing mechanism → accurate measured result. Preserve real numerical units, data origins, axes, baselines, assumptions and uncertainties.

Create a scene table spanning the whole timeline:

| Time | Claim | Source asset / evidence | Exact copy | Entry / interaction | Hold | Exit / audio cue |
| ---- | ----- | ----------------------- | ---------- | ------------------- | ---- | ---------------- |

Make every visual earn screen time: if it could appear unchanged in another product's video, remove it. Show real app UI and/or native result before listing abstract features. Source brand colors/fonts from actual product files. Do not paste a random recognizable brand's design.

### Typography and motion

- Large readable type, deliberate white space, strong contrast. Usually one headline and one supporting line.
- Settle readable text **~0.3s per word**; short labels **~0.8s**; headlines at least **~1.2s** fully visible. Entrance/exit time does _not_ count toward the hold.
- Favor 0.25–0.6s entrances, purposeful cuts, restrained transitions, and sequenced interactions (typing, clicking, checking, rendering) synchronized to subtle SFX.
- Avoid crossfading two dense screens simultaneously: clear the old content before presenting the new. Check both sides of transitions.
- Choose a **settled**, visually strong frame for the poster; each important frame should be postable independently.

## Tone choices

| Tone      | Visual / pacing                                                     |
| --------- | ------------------------------------------------------------------- |
| polished  | Editorial, quiet confidence, 3–4 generous scenes                    |
| cinematic | Dramatic type/reveals, but claims and actual assets remain accurate |
| technical | Evidence first, labeled geometry/charts, neutral transitions        |
| app-store | Real product UI and intentional interactions                        |
| playful   | Fast and specific, wit from the product                             |
| deadpan   | Sparse sound and copy, slower holds                                 |

Custom owner direction overrides presets. No generic neon cubes, unmotivated particles, unreadable overlays or fake product demos.

## Mandatory storyboard/style approval gate

Before a long/full render:

1. Save `plan.md` and `composition-brief.md` with source file/URI provenance, storyboard and time allocations.
2. Generate **at least three representative, fully settled, output-size styleframes**: hook, real product/action/technical proof, ending; plus a **3–8 second motion prototype** spanning a transition.
3. **Inspect visually** full-size stills, edges, captions, language glyphs, transitions and the encoded prototype. Hash/ffprobe alone is not aesthetic review.
4. Show the styleframes and motion sample for the owner's **visual approval**; do not presume approval from earlier permission to work. If the owner explicitly waives the review gate, document the waiver.
5. Only then full-render. Use fresh versioned job directories and preserve originals and previous rejected designs.

This hard gate addresses the failure of producing long, technically valid but aesthetically poor videos.

## Output

For a launch video: actual video, poster, share copy (1–3 specific sentences), editable source and assets, storyboard, provenance and QA report. Technical videos additionally include sourced numerical/data checks. See [delivery.md](delivery.md). Hyperframes is **optional only when separately installed and authorized**; neither its use nor sharing private inputs with an external provider is implicit.
