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

## Separate scores

Score technical correctness /100: determinism 25, data correctness 25, export integrity 20, readiness/errors 15, evidence 15. A failed gate blocks acceptance regardless of total.

Score visual quality /100: hierarchy/readability 25, story/pacing 25, motion continuity 20, chart/diagram clarity 20, consistency 10. Support scores with specific frames and observed flaws. Do not infer aesthetic quality from technical tests or assign 95+ without review.

For comparisons, anonymize outputs when practical. Fix brief, data, harness, duration/FPS, generation budget, tools, image inspection opportunities and revisions. Include all attempts and time/cost. Report uncertainty and sample count. Make no unsupported ranking claims about named models.
