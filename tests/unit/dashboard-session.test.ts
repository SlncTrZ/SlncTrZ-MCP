import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ownerSessionScript } from "../../src/owner/dashboard-session.js";

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
