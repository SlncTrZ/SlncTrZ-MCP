/** Shared headless CDP transport reused by Owner browser regressions. */
import { spawn } from "node:child_process";
import { createServer } from "node:net";

export class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message ?? "CDP command failed"));
        else waiter.resolve(message.result ?? {});
        return;
      }
      const waiters = this.waiters.get(message.method);
      if (!waiters?.length) return;
      this.waiters.delete(message.method);
      for (const waiter of waiters) waiter.resolve(message.params ?? {});
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitFor(method, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Timed out waiting for ${method}`)),
        timeoutMs
      );
      const wrapped = {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        }
      };
      const current = this.waiters.get(method) ?? [];
      current.push(wrapped);
      this.waiters.set(method, current);
    });
  }

  async evaluate(expression, awaitPromise = false) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? "Browser evaluation failed");
    }
    return result.result?.value;
  }

  async navigate(url) {
    const current = new URL(await this.evaluate("location.href")),
      target = new URL(url);
    if (current.href === target.href) {
      const loaded = this.waitFor("Page.loadEventFired");
      await this.send("Page.reload");
      await loaded;
      return;
    }
    if (
      current.origin === target.origin &&
      current.pathname === target.pathname &&
      current.search === target.search &&
      current.hash !== target.hash
    ) {
      await this.send("Page.navigate", { url });
      await this.poll("location.href===" + JSON.stringify(url));
      return;
    }
    const loaded = this.waitFor("Page.loadEventFired");
    await this.send("Page.navigate", { url });
    await loaded;
  }

  async poll(expression, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Browser condition timed out: ${expression}`);
  }

  close() {
    this.socket?.close();
  }
}

export async function reserveLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a Chrome DevTools port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

export async function startBrowser(browserCommand, profile) {
  const browserPort = await reserveLoopbackPort();
  return await new Promise((resolve, reject) => {
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${browserPort}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profile}`,
      "about:blank"
    ];
    if (process.env.SLNCTRZ_BROWSER_NO_SANDBOX === "1") args.splice(1, 0, "--no-sandbox");
    const child = spawn(browserCommand, args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: "" }
    });
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Chrome DevTools endpoint did not start: ${stderr.slice(-2000)}`));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = /DevTools listening on (ws:\/\/[^\s]+)/u.exec(stderr);
      if (!match?.[1]) return;
      clearTimeout(timeout);
      resolve({ child, browserWs: match[1] });
    });
  });
}
