# Technical motion design

## Story and pacing

Write the takeaway first, then one visual claim per scene. Use problem → mechanism → consequence when it fits. Let a diagram or chart carry the explanation instead of filling every scene with cards. Keep headings short and preserve time to read the fully revealed state.

At 1080p, begin with 64–80 px titles, 30–40 px supporting text and at least 24 px chart labels. Use a 96 px horizontal safe margin. Test actual text with measureText; wrap at words, never shrink indefinitely to hide overflow. Fail when copy cannot fit. Allow extra line height for Vietnamese diacritics.

Use a restrained palette: background, surface, text, muted text and two semantic accents. Use the same color for the same role throughout. Avoid decorative motion competing with data.

## Product-led cinematic composition

Adapt /brag's strongest rule: **the product in use is the hero**, not a generic
diagram of what the product might do. Use actual source UI, an explicitly annotated
representative UI, a real tool invocation/result, a measurable visual artifact,
or the native CAD/DCC scene. For an app with a working flow, sequence entry →
action → verified result before feature callouts.

- Do not stretch four generic neon-glass objects across a 45-second film.
- Avoid random noise/particles, gradient blobs, tiny overlays and decorative looped
  camera motion unless they show an actual mechanism.
- Match brand colors/fonts from checked-in product assets. Use purposeful negative
  space; reserve vibrant colors for semantic action/permission/result.
- Lock type, safe zones and authored timings across landscape/portrait adaptations.
- For a launch video, assess whether each _settled_ frame could be posted as an image;
  use the strongest one as a poster and place it in frame zero of the packaged cut.
- A 3–8-second inspected prototype and owner's visual approval are required
  before a costly full render, unless explicitly waived.

## Motion primitives

Use absolute seconds and clamped progress:

```js
const clamp = (x) => Math.max(0, Math.min(1, x));
const progress = (t, start, duration) => clamp((t - start) / duration);
const easeOut = (p) => 1 - (1 - p) ** 3;
const easeInOut = (p) => p * p * (3 - 2 * p);
```

Use ~0.4–0.7 s entrances, ~0.1–0.2 s stagger and ~0.3–0.5 s transitions as starting points. Use ease-out for entry, ease-in-out for movement and linear interpolation when a data value must progress uniformly. Avoid overshoot for quantities and bars. Hold final data states long enough to read.

## Diagrams and charts

Use explicit bounding rectangles and anchors. Route connectors behind nodes. Calculate lengths, alignment and arrowheads from the same geometry. Keep labels away from moving particles.

Use zero baselines for bars unless clearly justified and disclosed. Keep scales identical for comparisons. Carry units into axes and values. Animate normalized data values, not arbitrary pixel heights. Display synthetic/demo labels throughout illustrative scenes. Verify final values against the source.

## Review loop

Review contact sheets for consistency, then full-size frames for fine details. Review one frame before/at/after each boundary and animation extrema. Include first and last delivered frames. Watch an encoded preview for pacing; a contact sheet alone cannot establish smoothness. Treat deliberate static holds as valid.
