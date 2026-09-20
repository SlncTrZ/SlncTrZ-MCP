import { describe, expect, it } from "vitest";
import { DEBATE_OWNER_API_BASE, debatePageHtml } from "../../src/owner/debate-page.js";

describe("Debate owner page foundation", () => {
  it("preserves the Owner Console shell and exposes required Debate states without a new frontend stack", () => {
    const html = debatePageHtml();

    expect(DEBATE_OWNER_API_BASE).toBe("/owner/api/debates");
    expect(html).toContain('font-family:"SlncHertine"');
    expect(html).toContain("max-width:76rem");
    expect(html).toContain('href="/owner"');
    expect(html).toContain('href="/usage"');
    expect(html).toContain('href="/debate" aria-current="page"');
    expect(html).toContain("@media(prefers-color-scheme:dark)");
    expect(html).toContain("@media(prefers-reduced-motion:reduce)");
    expect(html).toContain(":focus-visible");
    expect(html).toContain("min-height:100dvh");

    for (const state of [
      "loading",
      "empty",
      "active",
      "waiting",
      "paused_timeout",
      "stopped",
      "completed",
      "error"
    ]) {
      expect(html).toContain(state);
    }

    expect(html).not.toContain("React");
    expect(html).not.toContain("tailwind");
    expect(html).not.toContain("gsap");
    expect(html).not.toContain("EventSource");
    expect(html).not.toContain("WebSocket");
    expect(html).not.toContain("—");
    expect(html).not.toContain("–");
  });

  it("uses authenticated owner APIs, transcript delta sequence, CSRF controls, and safe text rendering", () => {
    const html = debatePageHtml();

    expect(html).toContain("'/owner/api/session'");
    expect(html).toContain("'/owner/api/debates'");
    expect(html).toContain("afterSequence");
    expect(html).toContain("/stop");
    expect(html).toContain("/resume");
    expect(html).toContain("'x-slnctrz-csrf':csrf");
    expect(html).toContain("navigator.clipboard.writeText");
    expect(html).toContain("textContent=");
    expect(html).not.toContain("message.content+'</");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('id="loading-state"');
    expect(html).toContain('id="empty-state"');
    expect(html).toContain('id="page-error"');
    expect(html).toContain('id="resume-action"');
    expect(html).toContain('id="stop-action"');
    expect(html).toContain('id="copy-id-action"');
    expect(html).toContain(".final-summary{");
    expect(html).toContain("message.isFinal?' final-summary':''");
  });

  it("keeps browser refresh bounded and reconnects from the last observed sequence", () => {
    const html = debatePageHtml();

    expect(html).toContain("POLL_MS=2500");
    expect(html).toContain("setTimeout(scheduleRefresh");
    expect(html).toContain("lastSequence");
    expect(html).toContain("encodeURIComponent(String(lastSequence))");
    expect(html).not.toContain("setInterval(");
  });
});
