import { createServer } from "node:http";
import { createContext, runInContext } from "node:vm";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi, afterEach } from "vitest";
import { AdapterError, type ExtensionAdapter } from "../../src/extension/adapter.js";
import { createExtensionSupervisor } from "../../src/extension/supervisor.js";
import { createStreamableHttpAdapter } from "../../src/extension/streamable-http-adapter.js";
import { compileExtensionManifest } from "../../src/extension/manifest.js";
import { debatePageHtml } from "../../src/owner/debate-page.js";

afterEach(() => vi.unstubAllGlobals());
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
function adapter(
  call: ExtensionAdapter["callTool"],
  start: ExtensionAdapter["start"] = async () => undefined
): ExtensionAdapter {
  return {
    start,
    callTool: call,
    listTools: async () => [],
    health: () => "ready",
    stop: async () => undefined
  };
}
function rejectedSession() {
  return new AdapterError(
    "provider_session_invalid",
    "rejected",
    "session_invalid",
    undefined,
    true
  );
}
describe("provider request recovery acceptance", () => {
  it("recovers a real HTTP session rejection before dispatching queued writes", async () => {
    let session = 0,
      rejected = false,
      writes = 0,
      toolRequests = 0;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { method: string };
      response.setHeader("content-type", "application/json");
      if (body.method === "server/discover") {
        response.end(
          JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "legacy only" } })
        );
      } else if (body.method === "initialize") {
        session++;
        response.setHeader("mcp-session-id", String(session));
        response.end(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25" } })
        );
      } else if (body.method === "notifications/initialized") {
        response.writeHead(202);
        response.end();
      } else {
        toolRequests++;
        if (!rejected) {
          rejected = true;
          response.writeHead(404);
          response.end();
          return;
        }
        expect(request.headers["mcp-session-id"]).toBe("2");
        writes++;
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { content: [{ type: "text", text: "stored" }] }
          })
        );
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing listener address");
    const manifest = await compileExtensionManifest({
      id: "p",
      version: "1",
      transport: "streamable-http",
      endpoint: `http://127.0.0.1:${address.port}/mcp`,
      tools: [{ canonicalId: "p.write", riskClass: "write" }]
    });
    const supervisor = createExtensionSupervisor({
      adapter: createStreamableHttpAdapter(manifest),
      backoffBaseMs: 1,
      backoffJitterMs: 0
    });
    try {
      await supervisor.start();
      const results = await Promise.all([
        supervisor.invoke("write", { value: 1 }),
        supervisor.invoke("write", { value: 2 })
      ]);
      expect(results.every((result) => !result.isError)).toBe(true);
      expect(session).toBe(2);
      expect(toolRequests).toBe(3);
      expect(writes).toBe(2);
    } finally {
      await supervisor.stop();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it("recovers a rejected write once and executes its side effect exactly once", async () => {
    let calls = 0,
      writes = 0;
    const call = vi.fn(async () => {
      if (++calls === 1) throw rejectedSession();
      writes++;
      return { isError: false, truncated: false, text: "stored" };
    });
    const supervisor = createExtensionSupervisor({
      adapter: adapter(call),
      backoffBaseMs: 1,
      backoffJitterMs: 0
    });
    await supervisor.start();
    try {
      expect(await supervisor.invoke("write", {})).toMatchObject({
        isError: false,
        text: "stored",
        diagnostic: { recoveryState: "recovered" }
      });
      expect(call).toHaveBeenCalledTimes(2);
      expect(writes).toBe(1);
    } finally {
      await supervisor.stop();
    }
  });
  it("never replays a session error without definitive rejection evidence", async () => {
    const call = vi.fn(async () => {
      throw new AdapterError("provider_session_invalid", "ambiguous");
    });
    const supervisor = createExtensionSupervisor({
      adapter: adapter(call),
      backoffBaseMs: 1,
      backoffJitterMs: 0
    });
    await supervisor.start();
    try {
      expect(await supervisor.invoke("write", {})).toMatchObject({ isError: true });
      expect(call).toHaveBeenCalledTimes(1);
    } finally {
      await supervisor.stop();
    }
  });
  it("caps automatic replay at one even when the replacement session is rejected", async () => {
    const call = vi.fn(async () => {
      throw rejectedSession();
    });
    const supervisor = createExtensionSupervisor({
      adapter: adapter(call),
      backoffBaseMs: 1,
      backoffJitterMs: 0
    });
    await supervisor.start();
    try {
      expect(await supervisor.invoke("write", {})).toMatchObject({ isError: true });
      expect(call).toHaveBeenCalledTimes(2);
    } finally {
      await supervisor.stop();
    }
  });
  it("does not replay after caller cancellation during recovery", async () => {
    let starts = 0;
    const call = vi.fn(async () => {
      throw rejectedSession();
    });
    const supervisor = createExtensionSupervisor({
      adapter: adapter(call, async () => {
        if (++starts > 1) await pause();
      }),
      backoffBaseMs: 1,
      backoffJitterMs: 0
    });
    await supervisor.start();
    const controller = new AbortController();
    try {
      const result = supervisor.invoke("write", {}, { signal: controller.signal });
      await pause();
      controller.abort();
      expect(await result).toMatchObject({ isError: true });
      expect(call).toHaveBeenCalledTimes(1);
    } finally {
      await supervisor.stop();
    }
  });
  it("returns request errors without restarting a healthy provider", async () => {
    const start = vi.fn(async () => undefined);
    const call = vi.fn(async () => {
      throw new AdapterError("provider_request_error", "safe");
    });
    const supervisor = createExtensionSupervisor({ adapter: adapter(call, start) });
    await supervisor.start();
    try {
      expect(await supervisor.invoke("write", {})).toEqual({
        isError: true,
        truncated: false,
        text: "provider_request_error"
      });
      expect(start).toHaveBeenCalledTimes(1);
      expect(supervisor.state).toBe("ready");
    } finally {
      await supervisor.stop();
    }
  });
  it("marks only a legacy-session HTTP 404 as unexecuted and sanitizes invalid arguments", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        const request = JSON.parse(String(init.body)) as { method: string };
        if (request.method === "server/discover")
          return new Response(JSON.stringify({ error: { code: -32601 } }));
        if (request.method === "initialize")
          return new Response(JSON.stringify({ result: { protocolVersion: "2025-11-25" } }), {
            headers: { "mcp-session-id": "fixture-session" }
          });
        if (request.method === "notifications/initialized")
          return new Response(null, { status: 202 });
        if (++calls === 1) return new Response(null, { status: 404 });
        return new Response(
          JSON.stringify({ error: { code: -32602, message: "private provider detail" } })
        );
      })
    );
    const manifest = await compileExtensionManifest({
      id: "p",
      transport: "streamable-http",
      version: "1",
      endpoint: "http://127.0.0.1:1234/mcp",
      tools: [{ canonicalId: "p.write", riskClass: "write" }]
    });
    const http = createStreamableHttpAdapter(manifest);
    await http.start();
    await expect(http.callTool("write", {}, {})).rejects.toMatchObject({
      code: "provider_session_invalid",
      requestNotExecuted: true
    });
    await http.start();
    await expect(http.callTool("write", {}, {})).rejects.toMatchObject({
      code: "provider_request_error",
      message: "provider_request_error",
      requestNotExecuted: false
    });
    await http.stop();
  });
});

interface Element {
  textContent: string;
  className: string;
  dataset: Record<string, string>;
  disabled: boolean;
  children: Element[];
  classList: { add(): void; remove(): void; toggle(): void };
  append(...items: Element[]): void;
  appendChild(item: Element): void;
  replaceChildren(...items: Element[]): void;
  setAttribute(): void;
  addEventListener(): void;
  querySelector(): null;
}
function element(): Element {
  const e: Element = {
    textContent: "",
    className: "",
    dataset: {},
    disabled: false,
    children: [],
    classList: {
      add() {
        return undefined;
      },
      remove() {
        return undefined;
      },
      toggle() {
        return undefined;
      }
    },
    append(...items) {
      e.children.push(...items);
    },
    appendChild(item) {
      e.children.push(item);
    },
    replaceChildren(...items) {
      e.children = items;
    },
    setAttribute() {
      return undefined;
    },
    addEventListener() {
      return undefined;
    },
    querySelector() {
      return null;
    }
  };
  return e;
}
describe("Owner asynchronous state acceptance", () => {
  it("discards an old poll and old mutation when the Owner selects another Debate", async () => {
    const elements = new Map<string, Element>();
    const get = (id: string) => {
      if (!elements.has(id)) elements.set(id, element());
      return required(elements.get(id));
    };
    const context = createContext({
      document: {
        getElementById: get,
        createElement: element,
        createTextNode: (text: string) => ({ textContent: text })
      },
      setTimeout: () => 0,
      Date,
      encodeURIComponent
    });
    const script = required(required(debatePageHtml().split("<script>")[1]).split("</script>")[0]);
    runInContext(script.replace("boot();", ""), context);
    runInContext(
      "currentId='A';currentSnapshot={debateId:'A'};lastSequence=10;globalThis.pending={};api=(p)=>new Promise(r=>pending[p]=r);globalThis.poll=refreshCurrent();globalThis.mutation=mutateCurrent('/stop');globalThis.select=openDebate('B',true);",
      context
    );
    expect(get("stop-action").disabled).toBe(true);
    runInContext(
      "pending['/owner/api/debates/B']({debateId:'B',sequence:2,status:'completed',messages:[]})",
      context
    );
    await pause();
    runInContext(
      "pending['/owner/api/debates']({debates:[{debateId:'A'},{debateId:'B'}]})",
      context
    );
    await pause();
    runInContext(
      "pending['/owner/api/debates/A?afterSequence=10']({debateId:'A',sequence:11,status:'active',messages:[{sequence:11,content:'wrong transcript'}]});pending['/owner/api/debates/A/stop']({debateId:'A',sequence:11,status:'stopped',messages:[]})",
      context
    );
    await pause();
    expect(runInContext("currentId", context)).toBe("B");
    expect(runInContext("lastSequence", context)).toBe(2);
    expect(get("transcript").children).toHaveLength(0);
  });
  it.each(["label", "profile", "result-delivery"])(
    "autosave %s reports failure and blocks duplicate pending writes",
    async (action) => {
      const source = readFileSync(
        new URL("../../src/owner/web-console.ts", import.meta.url),
        "utf8"
      );
      const helper = source.slice(
        source.indexOf("async function saveConnectionRow("),
        source.indexOf("function renderConnections(")
      );
      const control = element();
      const row = { dataset: {}, querySelectorAll: () => [control] };
      const status = element();
      let reject!: (error: Error) => void;
      const api = vi.fn(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail;
          })
      );
      const rollback = vi.fn();
      const saved = vi.fn();
      const context = createContext({ api, clearTimeout: () => undefined, setTimeout: () => 0 });
      runInContext(helper, context);
      context.row = row;
      context.status = status;
      context.rollback = rollback;
      context.saved = saved;
      context.path = "/owner/api/connections/" + action;
      const pending = runInContext(
        "saveConnectionRow(row,status,path,{grantId:'fixture'},saved,rollback)",
        context
      ) as Promise<void>;
      await runInContext(
        "saveConnectionRow(row,status,path,{grantId:'fixture'},saved,rollback)",
        context
      );
      expect(api).toHaveBeenCalledTimes(1);
      expect(control.disabled).toBe(true);
      expect(status.textContent).toBe("Saving…");
      reject(new Error("private failure"));
      await pending;
      expect(status.textContent).toContain("Save could not be confirmed");
      expect(status.textContent).not.toContain("private failure");
      expect(rollback).toHaveBeenCalledTimes(1);
      expect(saved).not.toHaveBeenCalled();
      expect(control.disabled).toBe(false);
    }
  );
  it("shows SAVED only after persistence is acknowledged and preserves disabled controls", async () => {
    const source = readFileSync(new URL("../../src/owner/web-console.ts", import.meta.url), "utf8");
    const helper = source.slice(
      source.indexOf("async function saveConnectionRow("),
      source.indexOf("function renderConnections(")
    );
    const control = element();
    control.disabled = true;
    const row = { dataset: {}, querySelectorAll: () => [control] };
    const status = element();
    let resolve!: (result: unknown) => void;
    const saved = vi.fn();
    const context = createContext({
      row,
      status,
      saved,
      api: () =>
        new Promise((r) => {
          resolve = r;
        }),
      clearTimeout: () => undefined,
      setTimeout: () => 0
    });
    runInContext(helper, context);
    const pending = runInContext(
      "saveConnectionRow(row,status,'/fixture',{},saved,()=>{})",
      context
    ) as Promise<void>;
    expect(status.textContent).toBe("Saving…");
    resolve({ resultDelivery: "full-content" });
    await pending;
    expect(status.textContent).toBe("SAVED");
    expect(saved).toHaveBeenCalledWith({ resultDelivery: "full-content" });
    expect(control.disabled).toBe(true);
  });
});
