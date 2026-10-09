#!/usr/bin/env node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpClient, startBrowser } from "./lib/browser-cdp.mjs";

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

try {
  const started = await startBrowser(browserCommand, profile);
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
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
