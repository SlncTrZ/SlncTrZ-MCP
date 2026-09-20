import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { DEBATE_OWNER_API_BASE, debatePageHtml } from "../../src/owner/debate-page.js";

interface FakeElement {
  textContent: string;
  className: string;
  dataset: Record<string, string>;
  disabled: boolean;
  dateTime: string;
  children: FakeElement[];
  classList: {
    add(...names: string[]): void;
    remove(...names: string[]): void;
    toggle(name: string, force?: boolean): void;
  };
  append(...nodes: FakeElement[]): void;
  appendChild(node: FakeElement): FakeElement;
  replaceChildren(...nodes: FakeElement[]): void;
  querySelector(selector: string): FakeElement | null;
  addEventListener(type: string, listener: unknown): void;
}

function fakeElement(): FakeElement {
  const element: FakeElement = {
    textContent: "",
    className: "",
    dataset: {},
    disabled: false,
    dateTime: "",
    children: [],
    classList: {
      add: () => undefined,
      remove: () => undefined,
      toggle: () => undefined
    },
    append: (...nodes: FakeElement[]) => element.children.push(...nodes),
    appendChild: (node: FakeElement) => {
      element.children.push(node);
      return node;
    },
    replaceChildren: (...nodes: FakeElement[]) => {
      element.children.splice(0, element.children.length, ...nodes);
    },
    querySelector: (selector: string) => {
      const prefix = '[data-sequence="';
      const suffix = '"]';
      if (!selector.startsWith(prefix) || !selector.endsWith(suffix)) return null;
      const sequence = selector.slice(prefix.length, -suffix.length);
      return element.children.find((child) => child.dataset.sequence === sequence) ?? null;
    },
    addEventListener: () => undefined
  };
  return element;
}

function pageClient(html: string): {
  renderSnapshot(snapshot: unknown, resetTranscript: boolean): void;
  element(id: string): FakeElement;
} {
  const script = html.split("<script>\n")[1]?.split("\n</script>")[0];
  expect(script).toBeDefined();

  const elements = new Map<string, FakeElement>();
  const element = (id: string): FakeElement => {
    const existing = elements.get(id);
    if (existing) return existing;
    const created = fakeElement();
    elements.set(id, created);
    return created;
  };
  const document = {
    hidden: false,
    getElementById: (id: string) => element(id),
    createElement: () => fakeElement(),
    createTextNode: (text: string) => {
      const node = fakeElement();
      node.textContent = text;
      return node;
    }
  };
  const sandbox: Record<string, unknown> = {
    document,
    navigator: { clipboard: { writeText: async () => undefined } },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout: () => 0,
    encodeURIComponent,
    Date,
    Error,
    String,
    Number,
    Math
  };
  runInNewContext(
    script?.replace("boot();", "globalThis.__renderSnapshot=renderSnapshot;") ?? "",
    sandbox
  );

  return {
    renderSnapshot: sandbox.__renderSnapshot as (
      snapshot: unknown,
      resetTranscript: boolean
    ) => void,
    element
  };
}

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

  it("distinguishes duplicate nicknames by stable participant identity in current speaker and transcript", () => {
    const client = pageClient(debatePageHtml());
    client.renderSnapshot(
      {
        debateId: "debate-1",
        topic: "Duplicate display names",
        status: "active",
        sequence: 2,
        maxTurns: 4,
        completedTurns: 2,
        currentParticipantId: "participant-a",
        pickupDeadlineAt: null,
        responseDeadlineAt: null,
        pauseReason: null,
        participants: [
          { participantId: "participant-a", nickname: "Alpha", role: "creator" },
          { participantId: "participant-b", nickname: "Alpha", role: "joiner" }
        ],
        messages: [
          {
            sequence: 1,
            participantId: "participant-a",
            nickname: "Alpha",
            content: "Creator message",
            createdAt: "2026-09-20T10:00:00.000Z",
            isFinal: false
          },
          {
            sequence: 2,
            participantId: "participant-b",
            nickname: "Alpha",
            content: "Joiner message",
            createdAt: "2026-09-20T10:01:00.000Z",
            isFinal: false
          }
        ]
      },
      true
    );

    expect(client.element("speaker").textContent).toBe("Alpha · creator");
    expect(
      client
        .element("transcript")
        .children.map((message) => message.children[0]?.children[0]?.textContent)
    ).toEqual(["Alpha · creator", "Alpha · joiner"]);
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
