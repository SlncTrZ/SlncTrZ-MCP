import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ownerSessionScript } from "../../src/owner/dashboard-session.js";
import { workspaceCardControllerScript } from "../../src/owner/dashboard-shell.js";

class Element {
  dataset: Record<string, string> = {};
  textContent = "";
  hidden = false;
  disabled = false;
  onclick?: () => Promise<void>;
  private classes = new Set(["hidden"]);
  classList = {
    add: (key: string) => this.classes.add(key),
    remove: (key: string) => this.classes.delete(key),
    contains: (key: string) => this.classes.has(key),
    toggle: (key: string, force: boolean) => {
      if (force) this.classes.add(key);
      else this.classes.delete(key);
    }
  };
}
interface Controller {
  run(): Promise<void>;
  request(path: string, options?: Record<string, unknown>, csrf?: string): Promise<unknown>;
  expire(): void;
  readonly authenticated: boolean;
}
function response(status = 200, data: unknown = { authenticated: true }) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness(
  fetch: (path: string, options?: Record<string, unknown>) => Promise<unknown>,
  load: () => Promise<void> = () => Promise.resolve()
) {
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    let current = elements.get(id);
    if (!current) {
      current = new Element();
      elements.set(id, current);
    }
    return current;
  };
  let invalidations = 0;
  const events = new Map<string, (event?: { persisted: boolean }) => void>();
  const context = createContext({
    document: { getElementById: element },
    fetch,
    load,
    AbortController,
    Error,
    addEventListener: (name: string, listener: (event?: { persisted: boolean }) => void) => {
      events.set(name, listener);
    },
    onInvalidate: () => {
      invalidations++;
    }
  });
  runInContext(
    ownerSessionScript +
      `;globalThis.controller=createOwnerSession({contentId:'app',loginId:'login',onAuthenticated:load,onInvalidate});`,
    context
  );
  return {
    controller: context.controller as Controller,
    element,
    hidePage: () => events.get("pagehide")?.(),
    showPage: () => events.get("pageshow")?.({ persisted: true }),
    invalidations: () => invalidations
  };
}
function visible(element: Element) {
  return !element.classList.contains("hidden");
}

describe("Owner session and request states", () => {
  it("keeps login and protected content hidden while checking, and shares a pending check", async () => {
    const gate = deferred<ReturnType<typeof response>>();
    let checks = 0,
      loads = 0;
    const h = harness(
      async () => {
        checks++;
        return gate.promise;
      },
      async () => {
        loads++;
      }
    );
    const first = h.controller.run();
    expect(h.controller.run()).toBe(first);
    expect(visible(h.element("login"))).toBe(false);
    expect(visible(h.element("app"))).toBe(false);
    expect(h.element("owner-session-status").dataset.state).toBe("checking-session");
    gate.resolve(response());
    await first;
    expect(checks).toBe(1);
    expect(loads).toBe(1);
    expect(h.controller.authenticated).toBe(true);
    expect(visible(h.element("login"))).toBe(false);
    expect(visible(h.element("app"))).toBe(true);
    expect(h.element("owner-session-status").dataset.state).toBe("ready");
  });

  it.each(["server", "rate-limit", "network", "json", "invalid-session"] as const)(
    "shows retry without fake sign-in for a %s session error and recovers",
    async (failure) => {
      let recovered = false;
      const h = harness(async () => {
        if (recovered) return response();
        if (failure === "network") throw new Error("fixture network failure");
        if (failure === "json")
          return {
            ...response(),
            json: async () => {
              throw new Error("bad JSON");
            }
          };
        if (failure === "invalid-session") return response(200, {});
        return response(failure === "server" ? 500 : 429, { error: { code: "fixture_error" } });
      });
      await h.controller.run();
      expect(visible(h.element("login"))).toBe(false);
      expect(visible(h.element("app"))).toBe(false);
      expect(h.element("owner-session-status").dataset.state).toBe("session-check-error");
      expect(h.element("owner-session-retry").hidden).toBe(false);
      recovered = true;
      await h.element("owner-session-retry").onclick?.();
      expect(h.controller.authenticated).toBe(true);
      expect(h.element("owner-session-status").dataset.state).toBe("ready");
    }
  );

  it("shows sign-in only for an actual 401, even if its response JSON is invalid", async () => {
    const h = harness(async () => ({
      ...response(401),
      json: async () => {
        throw new Error("bad JSON");
      }
    }));
    await h.controller.run();
    expect(h.controller.authenticated).toBe(false);
    expect(visible(h.element("login"))).toBe(true);
    expect(visible(h.element("app"))).toBe(false);
  });

  it("keeps the authenticated shell when data loading fails", async () => {
    const h = harness(
      async () => response(),
      async () => {
        throw new Error("fixture data unavailable");
      }
    );
    await h.controller.run();
    expect(h.controller.authenticated).toBe(true);
    expect(visible(h.element("login"))).toBe(false);
    expect(visible(h.element("app"))).toBe(true);
    expect(h.element("owner-session-status").dataset.state).toBe("data-error");
  });

  it("preserves HTTP status/code and mutation CSRF without logging out on 403", async () => {
    let options: Record<string, unknown> | undefined;
    const h = harness(async (path, opts) => {
      if (path.endsWith("/session")) return response();
      options = opts;
      return response(403, { error: { code: "csrf_denied", message: "Fixture mutation denied" } });
    });
    await h.controller.run();
    await expect(
      h.controller.request("/owner/api/action", { method: "DELETE" }, "synthetic-marker")
    ).rejects.toMatchObject({ status: 403, code: "csrf_denied" });
    expect(options?.headers).toMatchObject({ "x-slnctrz-csrf": "synthetic-marker" });
    expect(h.controller.authenticated).toBe(true);
    expect(visible(h.element("app"))).toBe(true);
    expect(visible(h.element("login"))).toBe(false);
    expect(h.element("owner-session-message").textContent).toContain("try the action again");
  });

  it("locks the app and aborts pending work when a data request expires the session", async () => {
    const h = harness(async (path) => (path.endsWith("/session") ? response() : response(401)));
    await h.controller.run();
    await expect(h.controller.request("/owner/api/state")).rejects.toMatchObject({ status: 401 });
    expect(h.controller.authenticated).toBe(false);
    expect(visible(h.element("login"))).toBe(true);
    expect(visible(h.element("app"))).toBe(false);
    expect(h.invalidations()).toBe(2);
  });

  it("ignores a late data response after session invalidation", async () => {
    const gate = deferred<ReturnType<typeof response>>();
    const h = harness(async (path) => (path.endsWith("/session") ? response() : gate.promise));
    await h.controller.run();
    const request = h.controller.request("/owner/api/state");
    h.controller.expire();
    gate.resolve(response(200, { fixture: true }));
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(visible(h.element("app"))).toBe(false);
    expect(visible(h.element("login"))).toBe(true);
  });

  it("does not load protected data from a session response arriving after pagehide", async () => {
    const gate = deferred<ReturnType<typeof response>>();
    let loaded = false;
    const h = harness(
      async () => gate.promise,
      async () => {
        loaded = true;
      }
    );
    const pending = h.controller.run();
    h.hidePage();
    gate.resolve(response());
    await pending;
    expect(loaded).toBe(false);
    expect(h.controller.authenticated).toBe(false);
    expect(visible(h.element("app"))).toBe(false);
  });
  it("rechecks a page restored from browser history before showing protected content", async () => {
    let checks = 0;
    const h = harness(async () => {
      checks++;
      return response();
    });
    await h.controller.run();
    h.hidePage();
    expect(visible(h.element("app"))).toBe(false);
    h.showPage();
    await h.controller.run();
    expect(checks).toBe(2);
    expect(h.controller.authenticated).toBe(true);
    expect(visible(h.element("login"))).toBe(false);
  });

  it("rechecks history restoration after an old session check finishes", async () => {
    const gate = deferred<ReturnType<typeof response>>();
    let checks = 0;
    const h = harness(async () => {
      checks++;
      return checks === 1 ? gate.promise : response();
    });
    const old = h.controller.run();
    h.hidePage();
    h.showPage();
    gate.resolve(response());
    await old;
    await Promise.resolve();
    await h.controller.run();
    expect(checks).toBe(2);
    expect(h.controller.authenticated).toBe(true);
  });
});

class WsElement {
  textContent = "";
  hidden = false;
  disabled = false;
  value = "";
  dataset: Record<string, string> = {};
  focused = false;
  private listeners = new Map<string, Array<(event?: any) => void>>();
  addEventListener(type: string, fn: (event?: any) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  emit(type: string, event: any = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  focus() {
    this.focused = true;
  }
  select() {}
}

interface WsController {
  submit(): Promise<void>;
  openEdit(): void;
  closeEdit(): void;
  startGreetings(): void;
  stopGreetings(): void;
  rotateGreeting(): void;
  readonly savedName: string;
  readonly editing: boolean;
  readonly reducedMotion: boolean;
}

function wsHarness(
  opts: {
    request?: (path: string, opt?: Record<string, unknown>, csrf?: string) => Promise<unknown>;
    reducedMotion?: boolean;
    visibilityState?: string;
  } = {}
) {
  const elements = new Map<string, WsElement>();
  const element = (id: string) => {
    let current = elements.get(id);
    if (!current) {
      current = new WsElement();
      elements.set(id, current);
    }
    return current;
  };
  element("workspace-name").textContent = "Owner workspace";
  element("workspace-greeting").textContent = "Welcome back!";
  element("workspace-edit-form").hidden = true;
  element("workspace-name-feedback").hidden = true;

  const doc = { getElementById: element, visibilityState: opts.visibilityState ?? "visible" };
  const intervals: Array<{ fn: () => void; ms: number }> = [];
  const timeouts: Array<{ fn: () => void; ms: number }> = [];
  const clearedIntervals: number[] = [];
  const clearedTimeouts: number[] = [];
  const unload = new Map<string, () => void>();
  const calls: Array<{ path: string; opt: Record<string, unknown> | undefined; csrf: string | undefined }> = [];
  const requestFn = opts.request ?? (async () => ({ displayName: "Owner workspace" }));

  const context = createContext({
    document: doc,
    matchMedia: () => ({ matches: opts.reducedMotion === true }),
    setInterval: (fn: () => void, ms: number) => {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    clearInterval: (id: number) => {
      clearedIntervals.push(id);
    },
    setTimeout: (fn: () => void, ms: number) => {
      timeouts.push({ fn, ms });
      return timeouts.length;
    },
    clearTimeout: (id: number) => {
      if (id !== null) clearedTimeouts.push(id);
    },
    addEventListener: (name: string, fn: () => void) => {
      unload.set(name, fn);
    },
    __request: async (path: string, opt?: Record<string, unknown>, csrf?: string) => {
      calls.push({ path, opt, csrf });
      return requestFn(path, opt, csrf);
    },
    __getCsrf: () => "test-csrf",
    __reducedMotion: opts.reducedMotion === true
  });

  runInContext(
    workspaceCardControllerScript +
      ";globalThis.controller=createWorkspaceCard({request:__request,getCsrf:__getCsrf,reducedMotion:__reducedMotion});",
    context
  );

  return {
    controller: context.controller as WsController,
    element,
    intervals: () => intervals,
    timeouts: () => timeouts,
    clearedIntervals: () => clearedIntervals,
    patches: () => calls.filter((c) => c.opt?.method === "PATCH"),
    setVisibilityState: (value: string) => {
      doc.visibilityState = value;
    },
    fireUnload: (name: string) => {
      unload.get(name)?.();
    }
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("Workspace name inline edit and greetings lifecycle", () => {
  it("shows the default name, hidden form, and a 30s greeting rotation", async () => {
    const h = wsHarness();
    await flush();
    expect(h.element("workspace-name").textContent).toBe("Owner workspace");
    expect(h.element("workspace-edit-form").hidden).toBe(true);
    expect(h.element("workspace-name-feedback").hidden).toBe(true);
    expect(h.element("workspace-greeting").textContent).toBe("Welcome back!");
    expect(h.intervals()).toHaveLength(1);
    expect(h.intervals()[0]!.ms).toBe(30000);
  });

  it("updates the displayed name from /owner/api/workspace", async () => {
    const h = wsHarness({ request: async () => ({ displayName: "My workspace" }) });
    await flush();
    expect(h.element("workspace-name").textContent).toBe("My workspace");
  });

  it("opens the edit form with the current name and focuses the input", async () => {
    const h = wsHarness();
    await flush();
    h.element("workspace-edit-btn").emit("click");
    expect(h.element("workspace-name").hidden).toBe(true);
    expect(h.element("workspace-edit-btn").hidden).toBe(true);
    expect(h.element("workspace-edit-form").hidden).toBe(false);
    expect(h.element("workspace-name-input").value).toBe("Owner workspace");
    expect(h.element("workspace-name-input").focused).toBe(true);
  });

  it("rejects an empty or over-long name without patching", async () => {
    const h = wsHarness();
    await flush();
    h.element("workspace-edit-btn").emit("click");
    h.element("workspace-name-input").value = "   ";
    await h.controller.submit();
    expect(h.element("workspace-name-feedback").textContent).toContain("1 and 64");
    expect(h.element("workspace-edit-form").hidden).toBe(false);
    expect(h.patches()).toHaveLength(0);

    h.element("workspace-name-input").value = "a".repeat(65);
    await h.controller.submit();
    expect(h.patches()).toHaveLength(0);
    expect(h.element("workspace-edit-form").hidden).toBe(false);
  });

  it("patches a valid name with CSRF and reflects the saved name", async () => {
    const h = wsHarness({
      request: async (path, opt) => {
        if (opt?.method === "PATCH") return { ok: true, displayName: "New Name" };
        return { displayName: "Owner workspace" };
      }
    });
    await flush();
    h.element("workspace-edit-btn").emit("click");
    h.element("workspace-name-input").value = "  New Name  ";
    const saving = h.controller.submit();
    expect(h.element("workspace-name-input").disabled).toBe(true);
    expect(h.element("workspace-name-feedback").textContent).toBe("Saving...");
    await saving;
    const patch = h.patches()[0]!;
    expect(patch.path).toBe("/owner/api/workspace");
    expect(patch.opt?.method).toBe("PATCH");
    expect(JSON.parse(String(patch.opt?.body))).toEqual({ displayName: "New Name" });
    expect(patch.csrf).toBe("test-csrf");
    expect(h.element("workspace-name").textContent).toBe("New Name");
    expect(h.element("workspace-name").hidden).toBe(false);
    expect(h.element("workspace-edit-form").hidden).toBe(true);
    expect(h.element("workspace-name-feedback").textContent).toBe("Saved");
    expect(h.timeouts().some((t) => t.ms === 2000)).toBe(true);
    h.timeouts()
      .find((t) => t.ms === 2000)!
      .fn();
    expect(h.element("workspace-name-feedback").hidden).toBe(true);
  });

  it("keeps the form open and shows an error when saving fails", async () => {
    const h = wsHarness({
      request: async (path, opt) => {
        if (opt?.method === "PATCH") throw new Error("Fixture save failed");
        return { displayName: "Owner workspace" };
      }
    });
    await flush();
    h.element("workspace-edit-btn").emit("click");
    h.element("workspace-name-input").value = "Changed";
    await h.controller.submit();
    expect(h.element("workspace-edit-form").hidden).toBe(false);
    expect(h.element("workspace-name-feedback").textContent).toBe("Fixture save failed");
    expect(h.element("workspace-name-input").disabled).toBe(false);
    expect(h.element("workspace-name").textContent).toBe("Owner workspace");
  });

  it("cancels via Cancel or Escape and restores the previous name", async () => {
    const h = wsHarness();
    await flush();
    h.element("workspace-edit-btn").emit("click");
    h.element("workspace-name-input").value = "Temporary";
    h.element("workspace-name-cancel").emit("click");
    expect(h.element("workspace-edit-form").hidden).toBe(true);
    expect(h.element("workspace-name").hidden).toBe(false);
    expect(h.element("workspace-name-input").value).toBe("Owner workspace");

    h.element("workspace-edit-btn").emit("click");
    h.element("workspace-name-input").value = "Temporary 2";
    h.element("workspace-name-input").emit("keydown", { key: "Escape", preventDefault: () => {} });
    expect(h.element("workspace-edit-form").hidden).toBe(true);
    expect(h.element("workspace-name-input").value).toBe("Owner workspace");
  });

  it("cycles greetings and wraps back to the first", async () => {
    const h = wsHarness();
    await flush();
    const tick = () => h.intervals()[0]!.fn();
    expect(h.element("workspace-greeting").textContent).toBe("Welcome back!");
    tick();
    expect(h.element("workspace-greeting").textContent).toBe("Have a nice day!");
    tick();
    expect(h.element("workspace-greeting").textContent).toBe("How’s your day going?");
    tick();
    expect(h.element("workspace-greeting").textContent).toBe("Ready when you are.");
    tick();
    expect(h.element("workspace-greeting").textContent).toBe("Welcome back!");
  });

  it("pauses rotation when the tab is hidden", async () => {
    const h = wsHarness();
    await flush();
    const tick = () => h.intervals()[0]!.fn();
    tick();
    h.setVisibilityState("hidden");
    const paused = h.element("workspace-greeting").textContent;
    tick();
    expect(h.element("workspace-greeting").textContent).toBe(paused);
    h.setVisibilityState("visible");
    tick();
    expect(h.element("workspace-greeting").textContent).not.toBe(paused);
  });

  it("pauses rotation while the edit form is open", async () => {
    const h = wsHarness();
    await flush();
    const tick = () => h.intervals()[0]!.fn();
    h.controller.openEdit();
    const paused = h.element("workspace-greeting").textContent;
    tick();
    expect(h.element("workspace-greeting").textContent).toBe(paused);
    h.controller.closeEdit();
    tick();
    expect(h.element("workspace-greeting").textContent).not.toBe(paused);
  });

  it("shows a static greeting and skips the interval for reduced motion", async () => {
    const h = wsHarness({ reducedMotion: true });
    await flush();
    expect(h.element("workspace-greeting").textContent).toBe("Welcome back!");
    expect(h.intervals()).toHaveLength(0);
  });

  it("clears the greeting interval on page unload", async () => {
    const h = wsHarness();
    await flush();
    expect(h.intervals()).toHaveLength(1);
    expect(h.clearedIntervals()).toHaveLength(0);
    h.fireUnload("pagehide");
    expect(h.clearedIntervals()).toHaveLength(1);
  });
});
