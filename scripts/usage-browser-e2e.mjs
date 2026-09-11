#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [origin, passphraseFile] = process.argv.slice(2);
if (!origin || !passphraseFile) {
  throw new Error("usage: node scripts/usage-browser-e2e.mjs <origin> <passphrase-file>");
}
new URL(origin);
const passphrase = (await readFile(passphraseFile, "utf8")).replace(/\r?\n$/u, "");
if (!passphrase) throw new Error("Owner Passphrase file is empty");

const candidates = [
  process.env.SLNCTRZ_BROWSER,
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser"
].filter(Boolean);

async function commandExists(command) {
  return await new Promise((resolve) => {
    const child = spawn(command, ["--version"], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

let browserCommand;
for (const candidate of candidates) {
  if (await commandExists(candidate)) {
    browserCommand = candidate;
    break;
  }
}
if (!browserCommand) throw new Error("No Chromium/Chrome executable is available for browser E2E");

const profile = await mkdtemp(join(tmpdir(), "slnctrz-usage-browser-"));
let chrome;

class CdpClient {
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

async function startBrowser() {
  return await new Promise((resolve, reject) => {
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank"
    ];
    if (process.env.SLNCTRZ_BROWSER_NO_SANDBOX === "1") args.splice(1, 0, "--no-sandbox");
    const child = spawn(browserCommand, args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, HOME: profile }
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

try {
  const started = await startBrowser();
  chrome = started.child;
  const browserPort = new URL(started.browserWs).port;
  const targetResponse = await fetch(
    `http://127.0.0.1:${browserPort}/json/new?${encodeURIComponent("about:blank")}`,
    { method: "PUT" }
  );
  if (!targetResponse.ok)
    throw new Error(`Could not create browser target (${targetResponse.status})`);
  const target = await targetResponse.json();
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send("Page.enable");
  await client.send("Runtime.enable");

  await client.navigate(`${origin}/owner`);
  await client.poll("document.readyState === 'complete' && !!document.getElementById('signin')");
  await client.evaluate(
    `(() => { const s=document.getElementById('secret'); s.value=${JSON.stringify(passphrase)}; document.getElementById('signin').click(); return true; })()`
  );
  await client.poll(
    "document.getElementById('login').classList.contains('hidden') && !document.getElementById('app').classList.contains('hidden')"
  );

  await client.navigate(`${origin}/usage`);
  await client.poll(
    "!document.getElementById('dashboard').classList.contains('hidden') && document.getElementById('usage-error').classList.contains('hidden') && document.querySelectorAll('#tools .tool').length >= 1 && Number((document.getElementById('contexts')?.textContent || '0').replace(/[^0-9.]/g,'')) >= 1"
  );

  const initial = await client.evaluate(`(() => ({
    title: document.title,
    estimator: document.getElementById('estimator')?.textContent,
    tools: document.querySelectorAll('#tools .tool').length,
    contexts: Number((document.getElementById('contexts')?.textContent || '0').replace(/[^0-9.]/g,'')),
    avoided: document.getElementById('avoided-tokens')?.textContent,
    disclaimer: document.body.textContent.includes('Webchat prompts, normal model replies, and provider billing are not measured.')
  }))()`);
  if (initial.title !== "SlncTrZ Usage")
    throw new Error(`Unexpected usage title: ${initial.title}`);
  if (initial.estimator !== "utf8-bytes-v1")
    throw new Error(`Unexpected estimator: ${initial.estimator}`);
  if (initial.tools < 1) throw new Error("Usage page did not render a tool breakdown row");
  if (!(initial.contexts >= 1))
    throw new Error("Usage page did not render harness context savings data");
  if (!initial.disclaimer) throw new Error("Usage estimator disclaimer is missing");

  for (const range of ["24h", "7d", "30d", "all"]) {
    const state = await client.evaluate(
      `(async () => {
        const button=document.querySelector('button[data-range=${JSON.stringify(range)}]');
        button.click();
        await new Promise(r=>setTimeout(r,350));
        return {
          active: button.classList.contains('active'),
          errorHidden: document.getElementById('usage-error').classList.contains('hidden')
        };
      })()`,
      true
    );
    if (!state.active || !state.errorHidden) throw new Error(`Usage range failed: ${range}`);
  }

  const priceResult = await client.evaluate(`(() => {
    const input=document.getElementById('price');
    input.value='10';
    input.dispatchEvent(new Event('input',{bubbles:true}));
    return document.getElementById('price-result').textContent;
  })()`);
  if (!priceResult || priceResult === "$0.00") {
    throw new Error(`Custom price calculation did not produce a non-zero estimate: ${priceResult}`);
  }

  console.log(
    JSON.stringify({
      status: "pass",
      browser: browserCommand,
      title: initial.title,
      estimator: initial.estimator,
      toolRows: initial.tools,
      contexts: initial.contexts,
      avoided: initial.avoided,
      ranges: ["24h", "7d", "30d", "all"],
      customPriceResult: priceResult
    })
  );
  client.close();
} finally {
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (chrome.exitCode === null) {
      chrome.kill("SIGKILL");
      await new Promise((resolve) => chrome.once("exit", resolve));
    }
  }
  await rm(profile, { recursive: true, force: true });
}
