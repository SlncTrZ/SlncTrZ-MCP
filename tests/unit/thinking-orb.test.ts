import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  thinkingOrbHtml,
  thinkingOrbCss,
  thinkingOrbScript,
  ORB_ACTIVITY_STATES,
  ORB_ACTIVITY_MODES,
  ORB_ACCESSIBLE_LABELS,
  ORB_COLORS,
  ORB_PROVENANCE
} from "../../src/owner/thinking-orb.js";

const source = readFileSync(new URL("../../src/owner/thinking-orb.ts", import.meta.url), "utf8");

describe("thinking orb exports", () => {
  it("exports the HTML, CSS and script as non-empty strings", () => {
    expect(typeof thinkingOrbHtml).toBe("string");
    expect(typeof thinkingOrbCss).toBe("string");
    expect(typeof thinkingOrbScript).toBe("string");
    expect(thinkingOrbHtml.length).toBeGreaterThan(0);
    expect(thinkingOrbCss.length).toBeGreaterThan(0);
    expect(thinkingOrbScript.length).toBeGreaterThan(0);
  });

  it("renders the canvas element with a screen-reader fallback", () => {
    expect(thinkingOrbHtml).toContain('id="thinking-orb-canvas"');
    expect(thinkingOrbHtml).toContain('role="img"');
    expect(thinkingOrbHtml).toContain('aria-label="SlncTrZ gateway ready"');
    expect(thinkingOrbHtml).toContain("SlncTrZ gateway status indicator");
  });

  it("styles the canvas at the default 20px size with a 24px variant", () => {
    expect(thinkingOrbCss).toContain("--slnctrz-orb-size,20px");
    expect(thinkingOrbCss).toContain('data-size="24"');
  });
});

describe("thinking orb state definitions", () => {
  it("defines the seven accepted activity states", () => {
    expect(ORB_ACTIVITY_STATES).toEqual({
      ready: "ready",
      idle: "idle",
      connecting: "connecting",
      session: "session",
      working: "working",
      busy: "busy",
      error: "error"
    });
  });

  it("maps alias pairs onto the four canonical render modes", () => {
    expect(ORB_ACTIVITY_MODES.ready).toBe("idle");
    expect(ORB_ACTIVITY_MODES.idle).toBe("idle");
    expect(ORB_ACTIVITY_MODES.connecting).toBe("connecting");
    expect(ORB_ACTIVITY_MODES.session).toBe("connecting");
    expect(ORB_ACTIVITY_MODES.working).toBe("working");
    expect(ORB_ACTIVITY_MODES.busy).toBe("working");
    expect(ORB_ACTIVITY_MODES.error).toBe("error");
  });

  it("provides a non-empty accessible label for every accepted state", () => {
    for (const state of Object.values(ORB_ACTIVITY_STATES)) {
      expect(ORB_ACCESSIBLE_LABELS[state]).toBeTruthy();
      expect(ORB_ACCESSIBLE_LABELS[state].length).toBeGreaterThan(0);
    }
  });

  it("uses the dashboard theme ink colors", () => {
    expect(ORB_COLORS.sky).toBe("#8CC1E9");
    expect(ORB_COLORS.primary).toBe("#0055A0");
    expect(ORB_COLORS.error).toBe("#B23A4A");
  });
});

describe("thinking orb client controller", () => {
  it("exposes the window.SlncTrZOrb activity API", () => {
    expect(thinkingOrbScript).toContain("window.SlncTrZOrb");
    expect(thinkingOrbScript).toContain("setActivity");
    expect(thinkingOrbScript).toContain("getActivity");
  });

  it("updates aria-label and accessible title from the current state", () => {
    expect(thinkingOrbScript).toContain("setAttribute('aria-label', label)");
    expect(thinkingOrbScript).toContain("setAttribute('title', label)");
    expect(thinkingOrbScript).toContain("setAttribute('data-activity', state)");
  });

  it("pauses the animation loop while the document is hidden", () => {
    expect(thinkingOrbScript).toContain("visibilitychange");
    expect(thinkingOrbScript).toContain("document.hidden");
    expect(thinkingOrbScript).toContain("stopLoop");
  });

  it("renders a static frame and skips the loop under reduced motion", () => {
    expect(thinkingOrbScript).toContain("prefers-reduced-motion: reduce");
    expect(thinkingOrbScript).toContain("if (reduceMotion) { draw(0); return; }");
  });

  it("bounds devicePixelRatio with Math.min(devicePixelRatio, 2)", () => {
    expect(thinkingOrbScript).toContain("Math.min(window.devicePixelRatio || 1, 2)");
  });

  it("cleans up the animation frame and listeners on unload", () => {
    expect(thinkingOrbScript).toContain("cancelAnimationFrame");
    expect(thinkingOrbScript).toContain("removeEventListener");
    expect(thinkingOrbScript).toContain("beforeunload");
    expect(thinkingOrbScript).toContain("pagehide");
  });
});

describe("thinking orb provenance", () => {
  it("pins the upstream repository and commit", () => {
    expect(ORB_PROVENANCE.upstreamRepository).toBe("https://github.com/Jakubantalik/thinking-orbs");
    expect(ORB_PROVENANCE.upstreamCommit).toBe("de85557ca220332586d070d8788c0e1d6e877a0d");
    expect(ORB_PROVENANCE.upstreamVersion).toBe("0.3.1");
    expect(ORB_PROVENANCE.license).toBe("MIT");
    expect(ORB_PROVENANCE.copyright).toBe("Copyright (c) 2026 Jakub Antalik");
  });

  it("records the MIT license notice and attribution in the source file", () => {
    expect(source).toContain("MIT License");
    expect(source).toContain("Copyright (c) 2026 Jakub Antalik");
    expect(source).toContain("https://github.com/Jakubantalik/thinking-orbs");
    expect(source).toContain("de85557ca220332586d070d8788c0e1d6e877a0d");
  });
});
