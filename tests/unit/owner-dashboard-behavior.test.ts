import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ownerSessionScript } from "../../src/owner/dashboard-session.js";
import { workspaceCardControllerScript } from "../../src/owner/dashboard-shell.js";
import { providerDrawerScript } from "../../src/owner/provider-drawer.js";

class Element {
  textContent = "";
  value = "";
  hidden = false;
  disabled = false;
  className = "";
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: Element[] = [];
  handlers = new Map<string, (event?: unknown) => unknown>();
  classes = new Set<string>();
  classList = {
    add: (v: string) => this.classes.add(v),
    remove: (v: string) => this.classes.delete(v),
    contains: (v: string) => this.classes.has(v),
    toggle: (v: string, on: boolean) => {
      if (on) this.classes.add(v);
      else this.classes.delete(v);
    }
  };
  constructor(private onFocus: (el: Element) => void) {}
  addEventListener(name: string, fn: (event?: unknown) => unknown) {
    this.handlers.set(name, fn);
  }
  setAttribute(key: string, value: string) {
    this.attributes[key] = value;
  }
  focus() {
    this.onFocus(this);
  }
  select() {
    /* Browser input selection is not needed by this harness. */
  }
  appendChild(el: Element) {
    this.children.push(el);
  }
  prepend(el: Element) {
    this.children.unshift(el);
  }
  replaceChildren() {
    this.children = [];
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return this.children;
  }
  get offsetParent() {
    return {};
  }
  emit(name: string) {
    return this.handlers.get(name)?.();
  }
}
function gate() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const response = (data: unknown, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => data
});
const detail = (id: string) => ({
  id,
  name: id,
  enabled: true,
  status: "ready",
  tools: { accepted: [] }
});
interface Options {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}
function harness(
  custom?: (path: string, options: Options) => Promise<unknown>,
  frames?: (() => void)[]
) {
  const nodes = new Map<string, Element>();
  const doc = {
    readyState: "complete",
    visibilityState: "visible",
    activeElement: null as Element | null,
    getElementById: (id: string) => {
      if (!nodes.has(id))
        nodes.set(
          id,
          new Element((el) => {
            doc.activeElement = el;
          })
        );
      return nodes.get(id) as Element;
    },
    createElement: () =>
      new Element((el) => {
        doc.activeElement = el;
      }),
    addEventListener: () => {
      /* DOM-level keyboard events are covered by the browser matrix. */
    }
  };
  const calls: { path: string; options: Options }[] = [];
  let name = "Persisted workspace",
    changed = 0;
  const context = createContext({
    document: doc,
    AbortController,
    Error,
    fetch: async (path: string, options: Options = {}) => {
      calls.push({ path, options });
      if (path.endsWith("/session")) return response({ authenticated: true, csrf: "fixture-csrf" });
      if (custom) {
        const result = await custom(path, options);
        if (result !== undefined) return result;
      }
      if (path.endsWith("/workspace")) {
        if (options.method === "PATCH") {
          if (options.headers?.["x-slnctrz-csrf"] !== "fixture-csrf")
            return response({ error: { code: "csrf_denied" } }, 403);
          const payload = JSON.parse(options.body || "{}") as { displayName: string };
          name = payload.displayName;
        }
        return response({ displayName: name });
      }
      if (path.endsWith("/detail")) return response(detail(path.split("/").at(-2) || ""));
      return response({});
    },
    onChanged: () => {
      changed++;
    },
    addEventListener: () => {
      /* Lifecycle is exercised by the session API here. */
    },
    matchMedia: () => ({ matches: true }),
    setInterval: () => 1,
    clearInterval: () => {
      /* No real timer is created. */
    },
    setTimeout: () => 1,
    clearTimeout: () => {
      /* No real timer is created. */
    },
    requestAnimationFrame: (fn: () => void) => (frames ? frames.push(fn) : fn())
  });
  context.window = context;
  runInContext(
    "let ownerSession;" +
      ownerSessionScript +
      workspaceCardControllerScript +
      providerDrawerScript +
      ";globalThis.SlncTrZWorkspaceCard=createWorkspaceCard({reducedMotion:true});" +
      "ownerSession=createOwnerSession({contentId:'app',loginId:'login',onAuthenticated:async()=>{}});" +
      "SlncTrZProviderDrawer.init({request:(path,opt)=>ownerSession.request(path,opt),onChanged});" +
      "globalThis.session=ownerSession;",
    context
  );
  const drawer = context.SlncTrZProviderDrawer as {
    open(id: string): Promise<void>;
    close(): void;
  };
  const card = context.SlncTrZWorkspaceCard as {
    openEdit(): void;
    submit(): Promise<void>;
    savedName: string;
  };
  const session = context.session as {
    run(): Promise<void>;
    request(path: string): Promise<unknown>;
    expire(): void;
  };
  return { context, drawer, card, session, calls, el: doc.getElementById, changes: () => changed };
}

describe("Owner dashboard behavior", () => {
  it("does not reopen a closed drawer when an animation frame arrives late", async () => {
    const frames: (() => void)[] = [];
    const h = harness(undefined, frames);
    await h.session.run();
    await h.drawer.open("A");
    h.drawer.close();
    for (const frame of frames) frame();
    expect(h.el("provider-drawer").classList.contains("open")).toBe(false);
  });

  it("loads the name when the header mounts after a fast session response", async () => {
    const h = harness();
    await h.session.run();
    h.el("workspace-name").textContent = "Unknown name";
    runInContext("globalThis.lateCard=createWorkspaceCard({reducedMotion:true});", h.context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.el("workspace-name").textContent).toBe("Persisted workspace");
    expect((h.context.lateCard as { savedName: string }).savedName).toBe("Persisted workspace");
  });

  it("loads the saved name after authentication and renames with session CSRF without a page csrf global", async () => {
    const h = harness();
    expect(h.calls).toHaveLength(0);
    await h.session.run();
    expect(h.card.savedName).toBe("Persisted workspace");
    h.card.openEdit();
    h.el("workspace-name-input").value = "Renamed workspace";
    await h.card.submit();
    const patch = h.calls.find((c) => c.options.method === "PATCH");
    expect(patch?.options.headers?.["x-slnctrz-csrf"]).toBe("fixture-csrf");
    expect(h.card.savedName).toBe("Renamed workspace");
    await h.session.run();
    expect(h.card.savedName).toBe("Renamed workspace");
  });

  it("does not apply a pending name save after the session expires", async () => {
    const pending = gate();
    const h = harness(async (path, opt) =>
      path.endsWith("/workspace") && opt.method === "PATCH" ? pending.promise : undefined
    );
    await h.session.run();
    h.card.openEdit();
    h.el("workspace-name-input").value = "Old session name";
    const save = h.card.submit();
    h.session.expire();
    pending.resolve(response({ displayName: "Old session name" }));
    await save;
    expect(h.card.savedName).toBe("Persisted workspace");
    expect(h.el("workspace-edit-form").hidden).toBe(true);
    expect(h.el("workspace-name-feedback").textContent).toBe("");
  });

  it("keeps the Orb working until all requests complete and keeps errors visible until retry", async () => {
    const first = gate(),
      second = gate();
    let fail = false;
    const h = harness(async (path) =>
      path === "/first"
        ? first.promise
        : path === "/second"
          ? second.promise
          : path === "/failure" && fail
            ? response({ error: { message: "Unavailable" } }, 500)
            : undefined
    );
    await h.session.run();
    expect(h.context.SlncTrZOwnerActivity).toBe("ready");
    const a = h.session.request("/first"),
      b = h.session.request("/second");
    expect(h.context.SlncTrZOwnerActivity).toBe("working");
    first.resolve(response({}));
    await a;
    expect(h.context.SlncTrZOwnerActivity).toBe("working");
    second.resolve(response({}));
    await b;
    expect(h.context.SlncTrZOwnerActivity).toBe("ready");
    fail = true;
    await expect(h.session.request("/failure")).rejects.toThrow("Unavailable");
    expect(h.context.SlncTrZOwnerActivity).toBe("error");
    fail = false;
    await h.session.run();
    expect(h.context.SlncTrZOwnerActivity).toBe("ready");
    h.session.expire();
    expect(h.context.SlncTrZOwnerActivity).toBe("idle");
  });

  it.each(["test", "sync", "disable", "remove"])(
    "does not let pending %s on A overwrite or close B",
    async (action) => {
      const pending = gate();
      const h = harness(async (path, opt) =>
        path.startsWith("/owner/api/mcp/A") && opt.method !== "GET" ? pending.promise : undefined
      );
      await h.session.run();
      await h.drawer.open("A");
      let mutation: unknown;
      if (action === "disable" || action === "remove") {
        await h.el("provider-action-" + action).emit("click");
        expect(
          h.calls.filter((c) => c.options.method === "PATCH" || c.options.method === "DELETE")
        ).toHaveLength(0);
        mutation = h.el("confirm-modal-confirm").emit("click");
      } else mutation = h.el("provider-action-" + action).emit("click");
      await h.drawer.open("B");
      pending.resolve(response({}));
      await mutation;
      expect(h.el("provider-drawer-id").textContent).toBe("B");
      expect(h.el("provider-drawer").classList.contains("open")).toBe(true);
      expect(h.changes()).toBe(1);
      expect(h.calls.filter((c) => c.path === "/owner/api/mcp/A/detail")).toHaveLength(1);
      expect(
        h.calls.find((c) => c.options.method !== "GET" && c.path.startsWith("/owner/api/mcp/A"))
          ?.options.headers?.["x-slnctrz-csrf"]
      ).toBe("fixture-csrf");
    }
  );

  it("cancels confirmation without a mutation and refreshes the list once after confirmed removal", async () => {
    const h = harness();
    await h.session.run();
    await h.drawer.open("A");
    h.el("provider-action-remove").emit("click");
    h.el("confirm-modal-cancel").emit("click");
    await h.el("confirm-modal-confirm").emit("click");
    expect(h.calls.filter((c) => c.options.method === "DELETE")).toHaveLength(0);
    h.el("provider-action-remove").emit("click");
    await h.el("confirm-modal-confirm").emit("click");
    await h.el("confirm-modal-confirm").emit("click");
    expect(h.calls.filter((c) => c.options.method === "DELETE")).toHaveLength(1);
    expect(h.changes()).toBe(1);
    expect(h.el("provider-drawer").classList.contains("open")).toBe(false);
  });

  it("ignores a late action error after another provider opens", async () => {
    const pending = gate();
    const h = harness(async (path, opt) =>
      path.endsWith("/A/test") && opt.method === "POST" ? pending.promise : undefined
    );
    await h.session.run();
    await h.drawer.open("A");
    const action = h.el("provider-action-test").emit("click");
    await h.drawer.open("B");
    pending.resolve(response({ error: { message: "A failed" } }, 500));
    await action;
    expect(h.el("provider-drawer-id").textContent).toBe("B");
    expect(h.el("provider-drawer-error").hidden).toBe(true);
    expect(h.changes()).toBe(0);
  });
});
