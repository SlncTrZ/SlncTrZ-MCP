# Acceptance and fair comparison

## Technical gates (all required)

| Gate                  | Evidence                                                                 |
| --------------------- | ------------------------------------------------------------------------ |
| Fonts/images ready    | Explicit readiness, loaded asset hashes, no resource failures            |
| Arbitrary seek        | Identical PNG hash for forward/reverse/repeat samples in one environment |
| No wall-clock drift   | Capture again after delay without another render call                    |
| Correct timeline      | Contiguous scenes, integral duration×FPS, no extra endpoint              |
| Correct export        | ffprobe confirms H.264, yuv420p, dimensions, rate, count, duration       |
| No runtime error      | Fail on uncaught exceptions, console errors and asset failures           |
| Layout/data correct   | Page assertions plus visual review and source comparison                 |
| Reproducible evidence | Source/helper/asset/video SHA-256 and environment versions               |

## ## /brag-style creative and source gates

Before a full render, require all **applicable** source and visual gates independently of the technical score:

| Gate                      | Pass evidence                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| Verified product material | Real project source paths/UX/model outputs; synthetic UI explicitly labeled                           |
| Two-second hook           | A meaningful product-specific visual/action in the opening; not generic animation                     |
| 2–3 core beats            | The centerpiece shows real entry → authorized action → verified result                                |
| Readable settles          | Captions/headlines held after complete entrance; ~0.3s per word, short label ≥0.8s                    |
| Visual style review       | At least three settled styleframes and an inspected 3–8s prototype; owner approval or explicit waiver |
| Privacy/provenance        | Screens, logs and paths reviewed for secrets; asset and music licenses recorded                       |
| Final craft               | Poster from settled frame, beginning/middle/end watched, transitions and audio evaluated              |

**Do not auto-score creative approval.** A technically passing MP4 can still be rejected.
After a rejection, stop unused full-render workers, preserve assets and revise the
design with a new version; do not render the remaining footage before fixing the look.

For native Blender/CAD, require a saved native project, reopened independently,
keyframe/Geometry Nodes evidence and at least three distinctly animated sample frames;
do not conflate native scene proof with browser seekability.

For an optional musical launch cut, require approved score attribution, stereo
AAC or negotiated soundtrack codec, duration/sync/peak inspection and muted-viewing
caption legibility. For technical silent cut, explicitly record no audio.

Separate scores

Score technical correctness /100: determinism 25, data correctness 25, export integrity 20, readiness/errors 15, evidence 15. A failed gate blocks acceptance regardless of total.

Score visual quality /100: hierarchy/readability 25, story/pacing 25, motion continuity 20, chart/diagram clarity 20, consistency 10. Support scores with specific frames and observed flaws. Do not infer aesthetic quality from technical tests or assign 95+ without review.

For comparisons, anonymize outputs when practical. Fix brief, data, harness, duration/FPS, generation budget, tools, image inspection opportunities and revisions. Include all attempts and time/cost. Report uncertainty and sample count. Make no unsupported ranking claims about named models.
