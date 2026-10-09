/**
 * Thinking Orb Canvas Wrapper — self-contained canvas engine + client controller.
 * Wing: owner | Topic: thinking-orb | Updated: 2026-10-09 23:00
 *
 * Renders the header activity orb for the native Owner surfaces without pulling React
 * into the dashboard. The visual language (depth-shaded dotted spheres, tilted orbit
 * rings, harmonic oscillation) follows the upstream "thinking-orbs" project, but this
 * module is a zero-dependency Canvas implementation: no React, no runtime CDN, no npm
 * peer deps — everything ships inline so it runs inside the offline SEA artifact.
 *
 * Upstream provenance
 * -------------------
 * Upstream repository : https://github.com/Jakubantalik/thinking-orbs
 * Pinned commit       : de85557ca220332586d070d8788c0e1d6e877a0d
 * Upstream version    : 0.3.1
 * License             : MIT
 *
 * The upstream is a React component library; its engine layer (geometry/presets/draw
 * helpers) is MIT licensed. This module reimplements the same visual grammar as a
 * self-contained Canvas runtime. The full upstream MIT license text is reproduced below
 * as required by the license's attribution condition.
 *
 * ---
 * MIT License
 *
 * Copyright (c) 2026 Jakub Antalik
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 * ---
 */

/** Provenance record for the upstream "thinking-orbs" project (see header notice). */
export const ORB_PROVENANCE = {
  upstreamRepository: "https://github.com/Jakubantalik/thinking-orbs",
  upstreamCommit: "de85557ca220332586d070d8788c0e1d6e877a0d",
  upstreamVersion: "0.3.1",
  license: "MIT",
  copyright: "Copyright (c) 2026 Jakub Antalik"
} as const;

/**
 * Activity states accepted by `window.SlncTrZOrb.setActivity`.
 *
 * `ready`/`idle`, `connecting`/`session` and `working`/`busy` are alias pairs that map
 * onto the same render mode (see `ORB_ACTIVITY_MODES`); callers may use either spelling
 * so the header wiring can mirror the dashboard session vocabulary directly.
 */
export const ORB_ACTIVITY_STATES = {
  ready: "ready",
  idle: "idle",
  connecting: "connecting",
  session: "session",
  working: "working",
  busy: "busy",
  error: "error"
} as const;

export type OrbActivityState = (typeof ORB_ACTIVITY_STATES)[keyof typeof ORB_ACTIVITY_STATES];

/** Canonical render modes — the four canvas animation states. */
export type OrbRenderMode = "idle" | "connecting" | "working" | "error";

/** Maps every accepted activity state to its canonical render mode. */
export const ORB_ACTIVITY_MODES: Readonly<Record<OrbActivityState, OrbRenderMode>> = {
  ready: "idle",
  idle: "idle",
  connecting: "connecting",
  session: "connecting",
  working: "working",
  busy: "working",
  error: "error"
};

/** Accessible name / tooltip shown for each activity state. */
export const ORB_ACCESSIBLE_LABELS: Readonly<Record<OrbActivityState, string>> = {
  ready: "SlncTrZ gateway ready",
  idle: "SlncTrZ gateway idle",
  connecting: "Connecting to SlncTrZ gateway",
  session: "Checking SlncTrZ session",
  working: "SlncTrZ gateway working",
  busy: "SlncTrZ gateway busy",
  error: "SlncTrZ gateway error"
};

/** Theme ink colors, matching the dashboard shell palette (sky / primary / bad). */
export const ORB_COLORS = {
  sky: "#8CC1E9",
  primary: "#0055A0",
  error: "#B23A4A"
} as const;

/**
 * Markup for the canvas element that lives inside `#thinking-orb-container`.
 *
 * The element carries `role="img"` plus an `aria-label` that the client controller keeps
 * in sync with the current activity. The text between the `<canvas>` tags is the fallback
 * content: it is exposed to assistive technology and legacy browsers when the canvas
 * element (or 2D context) is unsupported.
 */
export const thinkingOrbHtml = `<canvas id="thinking-orb-canvas" class="slnctrz-orb-canvas" role="img" aria-label="${ORB_ACCESSIBLE_LABELS.ready}" width="20" height="20">SlncTrZ gateway status indicator</canvas>`;

/**
 * Styling for the orb canvas. Default rendered size is 20 CSS px (the upstream inline
 * preset); the 24 px header variant is available via `data-size="24"` or by overriding
 * `--slnctrz-orb-size`. Crisp rendering is handled by the controller, which backs the
 * canvas at `devicePixelRatio` (capped at 2) so the dots stay sharp on high-DPI screens.
 */
export const thinkingOrbCss = `
.slnctrz-orb-canvas{display:block;width:var(--slnctrz-orb-size,20px);height:var(--slnctrz-orb-size,20px);flex:none;vertical-align:middle;margin:0;padding:0;border:0;line-height:0}
.slnctrz-orb-canvas[data-size="24"]{width:24px;height:24px}
@media (prefers-reduced-motion: reduce){.slnctrz-orb-canvas{animation:none}}
`;

/**
 * Client-side controller that mounts to `#thinking-orb-canvas`.
 *
 * Exposes `window.SlncTrZOrb = { setActivity(state), getActivity() }` and handles:
 * - the four canvas animation states (idle / connecting / working / error);
 * - accessible `aria-label` and `title` updates per state;
 * - a paused requestAnimationFrame loop while the document is hidden;
 * - a clean static frame (and no loop) under `prefers-reduced-motion: reduce`;
 * - a `devicePixelRatio` bound of `Math.min(devicePixelRatio, 2)`;
 * - full listener / animation-frame cleanup on `beforeunload` / `pagehide`.
 */
export const thinkingOrbScript = `(function () {
  'use strict';
  var canvas = document.getElementById('thinking-orb-canvas');
  if (!canvas) { return; }
  var ctx = canvas.getContext('2d');
  if (!ctx) { return; }

  var STATES = ${JSON.stringify(ORB_ACTIVITY_STATES)};
  var MODES = ${JSON.stringify(ORB_ACTIVITY_MODES)};
  var LABELS = ${JSON.stringify(ORB_ACCESSIBLE_LABELS)};
  var COLORS = ${JSON.stringify(ORB_COLORS)};

  var activity = STATES.ready;
  var reduceMotion = false;
  var reducedQuery = null;
  if (typeof window.matchMedia === 'function') {
    reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    reduceMotion = !!reducedQuery.matches;
  }

  var rafId = 0;
  var running = false;
  var startTime = 0;
  var dpr = 1;
  var size = 20;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function hexRgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  var skyRgb = hexRgb(COLORS.sky);
  var primaryRgb = hexRgb(COLORS.primary);
  var errorRgb = hexRgb(COLORS.error);

  function mix(a, b, f) {
    var g = clamp(f, 0, 1);
    return [
      Math.round(a[0] + (b[0] - a[0]) * g),
      Math.round(a[1] + (b[1] - a[1]) * g),
      Math.round(a[2] + (b[2] - a[2]) * g)
    ];
  }
  function css(rgb, alpha) { return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha + ')'; }
  function ink(white) { return mix(primaryRgb, skyRgb, white); }

  function fibDir(i, n) {
    var golden = Math.PI * (3 - Math.sqrt(5));
    var y = 1 - (2 * (i + 0.5)) / n;
    var rad = Math.sqrt(1 - y * y);
    var a = i * golden;
    return [rad * Math.cos(a), y, rad * Math.sin(a)];
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    var measured = canvas.getBoundingClientRect().width || canvas.clientWidth;
    size = measured > 1 ? measured : 20;
    var px = Math.max(1, Math.round(size * dpr));
    if (canvas.width !== px) { canvas.width = px; }
    if (canvas.height !== px) { canvas.height = px; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawIdle(t) {
    var cx = size / 2;
    var cy = size / 2;
    var R = size * 0.34 * (1 + 0.08 * Math.sin(t * 1.5));
    var n = 24;
    for (var i = 0; i < n; i++) {
      var d = fibDir(i, n);
      var depth = (d[2] + 1) / 2;
      var x = cx + d[0] * R;
      var y = cy - d[1] * R;
      ctx.fillStyle = css(ink(1 - depth), 0.45 + 0.5 * depth);
      ctx.beginPath();
      ctx.arc(x, y, 0.9 + 1.2 * depth, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawConnecting(t) {
    var cx = size / 2;
    var cy = size / 2;
    var R = size * 0.33;
    var rings = 3;
    for (var o = 0; o < rings; o++) {
      var tilt = 0.25 + (o / rings) * 0.85;
      var spin = o * 1.7 + t * (0.4 + o * 0.18);
      var seg = 20;
      ctx.strokeStyle = css(ink(0.8), 0.6);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (var k = 0; k <= seg; k++) {
        var a = (k / seg) * Math.PI * 2;
        var x0 = Math.cos(a) * R;
        var y0 = Math.sin(a) * R;
        var y1 = y0 * Math.cos(tilt);
        var z1 = y0 * Math.sin(tilt);
        var x2 = x0 * Math.cos(spin) + z1 * Math.sin(spin);
        var px = cx + x2;
        var py = cy - y1;
        if (k === 0) { ctx.moveTo(px, py); } else { ctx.lineTo(px, py); }
      }
      ctx.closePath();
      ctx.stroke();
      var pa = o * 2.1 + t * (1.2 + o * 0.5);
      var pxa = Math.cos(pa) * R;
      var pya = Math.sin(pa) * R;
      var py1 = pya * Math.cos(tilt);
      var pz1 = pya * Math.sin(tilt);
      var px2 = pxa * Math.cos(spin) + pz1 * Math.sin(spin);
      ctx.fillStyle = css(ink(0.1), 0.95);
      ctx.beginPath();
      ctx.arc(cx + px2, cy - py1, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawWorking(t) {
    var cx = size / 2;
    var cy = size / 2;
    var rings = 2;
    for (var o = 0; o < rings; o++) {
      var phase = o * (Math.PI / rings);
      var R = size * (0.2 + 0.09 * Math.sin(t * 3.2 + phase) + 0.05 * Math.sin(t * 5.1 + phase * 1.6));
      var seg = 22;
      ctx.fillStyle = css(ink(o === 0 ? 0.05 : 0.4), 0.85);
      for (var k = 0; k < seg; k++) {
        var a = (k / seg) * Math.PI * 2 + t * 0.7;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * R, cy + Math.sin(a) * R, 1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawError() {
    var cx = size / 2;
    var cy = size / 2;
    var R = size * 0.36;
    ctx.fillStyle = css(errorRgb, 0.92);
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();
    var barW = Math.max(1.3, size * 0.08);
    var barH = size * 0.24;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(cx - barW / 2, cy - barH * 0.6, barW, barH);
    ctx.beginPath();
    ctx.arc(cx, cy + barH * 0.55, Math.max(1, size * 0.06), 0, Math.PI * 2);
    ctx.fill();
  }

  function modeFor(state) {
    var m = MODES[state];
    return typeof m === 'string' ? m : 'idle';
  }

  function draw(t) {
    ctx.clearRect(0, 0, size, size);
    var mode = modeFor(activity);
    if (mode === 'idle') { drawIdle(t); }
    else if (mode === 'connecting') { drawConnecting(t); }
    else if (mode === 'working') { drawWorking(t); }
    else { drawError(); }
  }

  function frame(ts) {
    if (!running) { return; }
    if (!startTime) { startTime = ts; }
    draw((ts - startTime) / 1000);
    rafId = window.requestAnimationFrame(frame);
  }

  function startLoop() {
    if (running) { return; }
    if (reduceMotion) { draw(0); return; }
    running = true;
    startTime = 0;
    rafId = window.requestAnimationFrame(frame);
  }

  function stopLoop() {
    running = false;
    if (rafId) { window.cancelAnimationFrame(rafId); rafId = 0; }
  }

  function setActivity(state) {
    if (!Object.prototype.hasOwnProperty.call(STATES, state)) { return; }
    activity = state;
    var label = LABELS[state] || LABELS.ready;
    canvas.setAttribute('aria-label', label);
    canvas.setAttribute('title', label);
    canvas.setAttribute('data-activity', state);
    if (reduceMotion) { draw(0); }
  }

  function getActivity() { return activity; }

  function onVisibility() {
    if (document.hidden) { stopLoop(); } else { startLoop(); }
  }

  function onResize() {
    resize();
    if (reduceMotion || !running) { draw(0); }
  }

  function onReducedChange(e) {
    reduceMotion = !!e.matches;
    if (reduceMotion) { stopLoop(); draw(0); } else { startLoop(); }
  }

  function cleanup() {
    stopLoop();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('beforeunload', cleanup);
    window.removeEventListener('pagehide', cleanup);
    if (reducedQuery && typeof reducedQuery.removeEventListener === 'function') {
      reducedQuery.removeEventListener('change', onReducedChange);
    }
  }

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('resize', onResize);
  window.addEventListener('beforeunload', cleanup);
  window.addEventListener('pagehide', cleanup);
  if (reducedQuery && typeof reducedQuery.addEventListener === 'function') {
    reducedQuery.addEventListener('change', onReducedChange);
  }

  window.SlncTrZOrb = {
    setActivity: setActivity,
    getActivity: getActivity
  };

  resize();
  setActivity(STATES.ready);
  startLoop();
})();`;
