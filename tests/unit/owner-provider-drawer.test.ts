import { describe, expect, it } from "vitest";
import {
  providerDrawerCss,
  providerDrawerHtml,
  providerDrawerScript
} from "../../src/owner/provider-drawer.js";

describe("providerDrawerHtml", () => {
  it("contains the drawer container, panel, tools list and confirmation modal", () => {
    expect(providerDrawerHtml).toContain('id="provider-drawer"');
    expect(providerDrawerHtml).toContain('id="provider-drawer-panel"');
    expect(providerDrawerHtml).toContain('id="provider-drawer-tools"');
    expect(providerDrawerHtml).toContain('id="provider-drawer-backdrop"');
    expect(providerDrawerHtml).toContain('id="confirm-modal"');
    expect(providerDrawerHtml).toContain('id="confirm-modal-backdrop"');
  });

  it("includes header, metadata, tools search, actions and modal controls", () => {
    expect(providerDrawerHtml).toContain('id="provider-drawer-name"');
    expect(providerDrawerHtml).toContain('id="provider-drawer-id"');
    expect(providerDrawerHtml).toContain('id="provider-drawer-status"');
    expect(providerDrawerHtml).toContain('id="provider-drawer-close"');
    expect(providerDrawerHtml).toContain('id="provider-drawer-loading"');
    expect(providerDrawerHtml).toContain('id="provider-drawer-meta"');
    expect(providerDrawerHtml).toContain('id="provider-drawer-tools-search"');
    expect(providerDrawerHtml).toContain('id="provider-drawer-actions"');
    expect(providerDrawerHtml).toContain('id="provider-action-test"');
    expect(providerDrawerHtml).toContain('id="provider-action-sync"');
    expect(providerDrawerHtml).toContain('id="provider-action-disable"');
    expect(providerDrawerHtml).toContain('id="provider-action-remove"');
    expect(providerDrawerHtml).toContain('id="confirm-modal-title"');
    expect(providerDrawerHtml).toContain('id="confirm-modal-body"');
    expect(providerDrawerHtml).toContain('id="confirm-modal-cancel"');
    expect(providerDrawerHtml).toContain('id="confirm-modal-confirm"');
  });

  it("declares dialog semantics and accessible close affordances", () => {
    expect(providerDrawerHtml).toContain('role="dialog"');
    expect(providerDrawerHtml).toContain('aria-modal="true"');
    expect(providerDrawerHtml).toContain('aria-labelledby="provider-drawer-name"');
    expect(providerDrawerHtml).toContain('aria-label="Close details"');
    expect(providerDrawerHtml).toContain('role="alertdialog"');
    expect(providerDrawerHtml).toContain('aria-labelledby="confirm-modal-title"');
    expect(providerDrawerHtml).toContain('aria-describedby="confirm-modal-body"');
  });
});

describe("providerDrawerCss", () => {
  it("slides the drawer in from the right with a 240ms transition", () => {
    expect(providerDrawerCss).toContain("translateX(100%)");
    expect(providerDrawerCss).toContain("translateX(0)");
    expect(providerDrawerCss).toContain("240ms");
  });

  it("uses frosted glass header/footer and an independently scrollable tools list", () => {
    expect(providerDrawerCss).toContain("backdrop-filter:blur");
    expect(providerDrawerCss).toContain(".provider-drawer-tools{max-height:320px;overflow-y:auto");
  });

  it("defines z-index layers for backdrop, drawer and modal", () => {
    expect(providerDrawerCss).toContain("z-index:60");
    expect(providerDrawerCss).toContain("z-index:61");
    expect(providerDrawerCss).toContain("z-index:70");
    expect(providerDrawerCss).toContain("z-index:71");
  });

  it("centers the confirmation modal with a capped width", () => {
    expect(providerDrawerCss).toContain("top:50%;left:50%;transform:translate(-50%,-50%)");
    expect(providerDrawerCss).toContain("max-width:440px");
  });

  it("renders full-width at 375px and respects reduced motion", () => {
    expect(providerDrawerCss).toContain("@media (max-width:375px)");
    expect(providerDrawerCss).toContain("width:100vw");
    expect(providerDrawerCss).toContain("@media (prefers-reduced-motion:reduce)");
  });
});

describe("providerDrawerScript", () => {
  it("is syntactically valid JavaScript", () => {
    expect(() => new Function(providerDrawerScript)).not.toThrow();
  });

  it("guards against stale responses with an AbortController and generation counter", () => {
    expect(providerDrawerScript).toContain("AbortController");
    expect(providerDrawerScript).toContain("generation");
    expect(providerDrawerScript).toContain("activeAbort.abort()");
    expect(providerDrawerScript).toContain("myGeneration !== generation");
  });

  it("sends the CSRF header on non-GET requests", () => {
    expect(providerDrawerScript).toContain("x-slnctrz-csrf");
    expect(providerDrawerScript).toContain("csrf");
  });

  it("only mutates after explicit confirm and cancels via cancel/escape/backdrop", () => {
    expect(providerDrawerScript).toContain("handleConfirm");
    expect(providerDrawerScript).toContain("closeConfirmation");
    expect(providerDrawerScript).toContain("confirm-modal-cancel");
    expect(providerDrawerScript).toContain("Escape");
  });

  it("targets the PATCH/DELETE endpoints for disable and remove", () => {
    expect(providerDrawerScript).toContain("method: 'PATCH'");
    expect(providerDrawerScript).toContain("method: 'DELETE'");
  });

  it("exposes an init/open/close API and never assigns dynamic text via innerHTML", () => {
    expect(providerDrawerScript).toContain("SlncTrZProviderDrawer");
    expect(providerDrawerScript).toContain("textContent");
    expect(providerDrawerScript).not.toContain("innerHTML");
  });
});
