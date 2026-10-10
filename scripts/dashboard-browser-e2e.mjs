/** Behavior regressions using actual Owner HTML and isolated, CSRF-enforcing API fixtures. */
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createOwnerWebConsole } from "../dist/owner/web-console.js";
import { CdpClient, startBrowser } from "./lib/browser-cdp.mjs";

const [reportFile, htmlOrigin] = process.argv.slice(2);
if (!reportFile)
  throw new Error("usage: node scripts/dashboard-browser-e2e.mjs <report.json> [native-origin]");
if (
  htmlOrigin &&
  (new URL(htmlOrigin).hostname !== "127.0.0.1" || new URL(htmlOrigin).protocol !== "http:")
)
  throw new Error("Native origin must use loopback HTTP");
const report = resolve(reportFile),
  checks = [],
  requests = [],
  external = [];
const profile = await mkdtemp(join(tmpdir(), "slnctrz-dashboard-browser-"));
const owner = createOwnerWebConsole({
  ownerSecretHash: "",
  policyStore: {},
  statePaths: {},
  mutation: {}
});
let name = "Persisted workspace",
  delay = 0,
  mutationFailure = false,
  sessionDelay = 0;
let chrome, client, origin;
const providers = new Map(
  ["A", "B"].map((id) => [id, { id, name: id, enabled: true, status: "ready", tools: 0 }])
);
const csrf = "synthetic-dashboard-csrf";
function json(res, code, data) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}
const fixture = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, origin || "http://127.0.0.1").pathname;
    if (path.startsWith("/owner/api/")) {
      const record = { path, method: req.method, completed: false };
      requests.push(record);
      if (path === "/owner/api/session") {
        await new Promise((r) => setTimeout(r, sessionDelay));
        json(res, 200, { authenticated: true, csrf });
        record.completed = true;
        return;
      }
      if (req.method !== "GET") {
        if (req.headers["x-slnctrz-csrf"] !== csrf) {
          json(res, 403, { error: { code: "csrf_denied", message: "Fixture CSRF required" } });
          return;
        }
        await new Promise((r) => setTimeout(r, delay));
        if (mutationFailure) {
          json(res, 500, { error: { message: "Fixture action failed" } });
          record.completed = true;
          return;
        }
      }
      if (path === "/owner/api/workspace") {
        if (req.method === "PATCH") {
          let body = "";
          for await (const part of req) body += part;
          name = JSON.parse(body).displayName;
        }
        json(res, 200, { displayName: name });
      } else if (path === "/owner/api/state")
        json(res, 200, {
          authorityMode: "restricted",
          paths: [],
          commands: [],
          commandCatalog: { status: "ready" },
          mcpServers: [...providers.values()],
          connections: [],
          product: {}
        });
      else if (
        path === "/owner/api/debates" ||
        path.endsWith("/timeseries") ||
        path.endsWith("/tools")
      )
        json(res, 200, []);
      else if (path.startsWith("/owner/api/mcp/")) {
        const id = path.split("/")[4],
          p = providers.get(id);
        if (req.method === "DELETE") {
          providers.delete(id);
          json(res, 200, {});
        } else if (req.method === "PATCH") {
          let body = "";
          for await (const part of req) body += part;
          p.enabled = JSON.parse(body).enabled;
          p.status = p.enabled ? "ready" : "disabled";
          json(res, 200, {});
        } else if (path.endsWith("/detail"))
          json(res, 200, {
            ...p,
            tools: {
              accepted: [
                { canonicalId: id + ".tool", description: "Fixture tool", riskClass: "low" }
              ]
            }
          });
        else json(res, 200, {});
      } else
        json(res, 200, {
          estimatedTotalTokens: 0,
          estimatedOutputTokens: 0,
          calls: 0,
          estimatorId: "utf8-bytes-v1",
          avoidedEstimatedTokens: 0,
          reductionPercent: 0,
          potentialEagerEstimatedTokens: 0,
          disclosedEstimatedTokens: 0,
          contexts: 0,
          degraded: false
        });
      record.completed = true;
      return;
    }
    if (htmlOrigin) {
      const upstream = await fetch(htmlOrigin + path);
      const headers = {
        "content-type": upstream.headers.get("content-type") || "application/octet-stream"
      };
      const csp = upstream.headers.get("content-security-policy");
      if (csp) headers["content-security-policy"] = csp;
      res.writeHead(upstream.status, headers);
      res.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }
    if (path === "/assets/meilin/idle-v1.webp") {
      const bytes = await readFile(new URL("../src/assets/meilin/idle-v1.webp", import.meta.url));
      res.writeHead(200, { "content-type": "image/webp" });
      res.end(bytes);
      return;
    }
    if (await owner.handle(req, res, path)) return;
    res.writeHead(404);
    res.end();
  } catch {
    if (!res.writableEnded) {
      res.writeHead(500);
      res.end();
    }
  }
});
async function check(label, expression) {
  const pass = !!(await client.evaluate(expression));
  checks.push({ label, pass });
  if (!pass) throw new Error("Dashboard check failed: " + label);
}
const click = (id) =>
  client.evaluate("document.getElementById(" + JSON.stringify(id) + ").click()");
const activity = (state) =>
  client.poll("window.SlncTrZOrb?.getActivity()===" + JSON.stringify(state));
async function navigate(path) {
  console.log(JSON.stringify({ stage: "navigate", path }));
  await client.navigate(origin + path);
  await client.poll("document.getElementById('owner-session-status')?.dataset.state==='ready'");
  await activity("ready");
}
async function open(id) {
  await client.evaluate("window.SlncTrZProviderDrawer.open(" + JSON.stringify(id) + ")", true);
}
try {
  fixture.listen({ host: "127.0.0.1", port: 0 });
  await once(fixture, "listening");
  origin = "http://127.0.0.1:" + fixture.address().port;
  const browser = await startBrowser(
    process.env.SLNCTRZ_BROWSER ||
      (process.platform === "win32"
        ? "C:/Program Files/Google/Chrome/Application/chrome.exe"
        : "google-chrome-stable"),
    profile
  );
  chrome = browser.child;
  const target = await (
    await fetch("http://127.0.0.1:" + new URL(browser.browserWs).port + "/json/new?about:blank", {
      method: "PUT"
    })
  ).json();
  client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Network.enable");
  await client.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }]
  });
  await client.send("Page.addScriptToEvaluateOnNewDocument", {
    source:
      "window.__dashboardErrors=[];addEventListener('error',e=>__dashboardErrors.push(e.message));addEventListener('securitypolicyviolation',e=>__dashboardErrors.push('CSP '+e.violatedDirective));"
  });
  // Session delay exposes the connecting state, including initialization before the Orb exists.
  sessionDelay = 500;
  await client.navigate(origin + "/#mcp");
  await activity("connecting");
  checks.push({ label: "session-connects", pass: true });
  await client.poll("document.getElementById('owner-session-status')?.dataset.state==='ready'");
  sessionDelay = 0;
  for (const path of ["/#mcp", "/usage", "/debate"]) {
    await navigate(path);
    await check(
      path + " full-width MeiLin above text",
      "(()=>{const c=document.getElementById('workspace-card').getBoundingClientRect(),m=document.getElementById('workspace-meilin').getBoundingClientRect(),t=document.querySelector('.workspace-copy').getBoundingClientRect();return !document.querySelector('.workspace-avatar')&&Math.abs(m.width-c.width+2)<2&&t.top>=m.bottom-1})()"
    );
    await check(
      path + " contiguous menu",
      "(()=>{const a=document.querySelector('[data-section=access]').getBoundingClientRect(),u=document.querySelector('[data-section=usage]').getBoundingClientRect();return a.top-u.bottom<=6})()"
    );
    await check(
      path + " reduced-motion static MeiLin",
      "getComputedStyle(document.getElementById('workspace-meilin')).backgroundPosition==='0% 0px'"
    );
    const asset = await client.evaluate(
      "fetch('/assets/meilin/idle-v1.webp').then(async r=>({ok:r.ok,type:r.headers.get('content-type'),size:(await r.arrayBuffer()).byteLength}))",
      true
    );
    checks.push({
      label: path + " bundled WebP loads",
      pass: asset.ok && asset.type === "image/webp" && asset.size === 101332
    });
    if (!checks.at(-1).pass) throw Error("MeiLin artwork failed to load");
    await check(
      path + " loads persisted name",
      "document.getElementById('workspace-name').textContent===" + JSON.stringify(name)
    );
    delay = 300;
    await click("workspace-edit-btn");
    const next = "Workspace " + path;
    await client.evaluate(
      "document.getElementById('workspace-name-input').value=" + JSON.stringify(next)
    );
    await click("workspace-name-save");
    await activity("working");
    await client.poll("document.getElementById('workspace-name-feedback').dataset.state==='saved'");
    await activity("ready");
    await check(
      path + " authenticated rename",
      "document.getElementById('workspace-name').textContent===" + JSON.stringify(next)
    );
    delay = 0;
    await navigate(path === "/debate" ? "/usage" : "/debate");
    await check(
      path + " cross-page persistence",
      "document.getElementById('workspace-name').textContent===" + JSON.stringify(next)
    );
    await check(path + " CSP and runtime", "window.__dashboardErrors.length===0");
  }
  await navigate("/#mcp");
  await check(
    "row has only Details",
    "[...document.querySelectorAll('#mcp .item button')].every(e=>e.textContent==='Details')"
  );
  await client.evaluate("document.querySelector('#mcp .item button').click()");
  await client.poll(
    "document.getElementById('provider-drawer-id').textContent==='A' && document.getElementById('provider-drawer-loading').hidden"
  );
  for (const action of ["test", "sync"]) {
    delay = 350;
    await open("A");
    await click("provider-action-" + action);
    await activity("working");
    await open("B");
    await new Promise((r) => setTimeout(r, 500));
    await check(
      action + " completion preserves B",
      "document.getElementById('provider-drawer-id').textContent==='B' && !document.getElementById('provider-drawer').hidden"
    );
    await activity("ready");
    delay = 0;
  }
  await open("A");
  const patches = requests.filter((r) => r.method === "PATCH" && r.path.includes("/mcp/")).length;
  await click("provider-action-disable");
  await check(
    "disable needs centered confirmation",
    "!document.getElementById('confirm-modal').hidden && document.activeElement.id==='confirm-modal-cancel'"
  );
  await click("confirm-modal-cancel");
  checks.push({
    label: "cancel has no provider mutation",
    pass:
      requests.filter((r) => r.method === "PATCH" && r.path.includes("/mcp/")).length === patches
  });
  await click("provider-action-disable");
  await click("confirm-modal-confirm");
  await client.poll("document.getElementById('provider-action-disable').textContent==='Enable'");
  await check(
    "disable refreshes provider row",
    "document.querySelector('#mcp [data-status=disabled]')!==null"
  );
  await click("provider-drawer-close");
  await open("B");
  await click("provider-action-remove");
  await click("confirm-modal-confirm");
  await client.poll("document.querySelectorAll('#mcp .item').length===1");
  await check(
    "remove closes drawer and refreshes row list",
    "!document.getElementById('provider-drawer').classList.contains('open')"
  );
  await open("A");
  mutationFailure = true;
  await click("provider-action-test");
  await activity("error");
  await check(
    "action failure is visible",
    "!document.getElementById('provider-drawer-error').hidden"
  );
  mutationFailure = false;
  await click("owner-session-retry");
  await activity("ready");
  await open("A");
  for (const width of [375, 768, 1440]) {
    await client.send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: width === 375
    });
    await check("layout " + width, "document.documentElement.scrollWidth<=innerWidth+1");
    await client.evaluate("document.getElementById('provider-action-remove').focus()");
    await client.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9
    });
    await client.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9
    });
    await check("drawer traps Tab " + width, "document.activeElement.id==='provider-drawer-close'");
    const screenshot = await client.send("Page.captureScreenshot", { format: "png" });
    await writeFile(
      join(
        resolve(report, ".."),
        process.platform + "-" + (htmlOrigin ? "native" : "source") + "-dashboard-" + width + ".png"
      ),
      Buffer.from(screenshot.data, "base64")
    );
  }
  await check(
    "reduced-motion Orb remains canvas",
    "document.querySelector('#thinking-orb-canvas')?.tagName==='CANVAS'"
  );
  await client.evaluate("window.SlncTrZProviderDrawer.close()");
  await client.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }]
  });
  await client.poll(
    "getComputedStyle(document.getElementById('workspace-meilin')).backgroundPosition!=='0% 0px'",
    10000
  );
  checks.push({ label: "MeiLin animates with motion enabled", pass: true });
  await client.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }]
  });
  await client.poll(
    "getComputedStyle(document.getElementById('workspace-meilin')).backgroundPosition==='0% 0px'"
  );
  await new Promise((r) => setTimeout(r, 700));
  await check(
    "MeiLin stops after motion preference changes",
    "getComputedStyle(document.getElementById('workspace-meilin')).backgroundPosition==='0% 0px'"
  );
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  });
  const sidebarScreenshot = await client.send("Page.captureScreenshot", { format: "png" });
  await writeFile(
    join(
      resolve(report, ".."),
      process.platform + "-" + (htmlOrigin ? "native" : "source") + "-meilin-overview.png"
    ),
    Buffer.from(sidebarScreenshot.data, "base64")
  );
  await check("final CSP and runtime", "window.__dashboardErrors.length===0");
  const resourceOrigins = await client.evaluate(
    "performance.getEntriesByType('resource').map(e=>new URL(e.name).origin)"
  );
  external.push(...resourceOrigins.filter((o) => o !== origin));
  checks.push({ label: "offline assets have no external dependency", pass: external.length === 0 });
  const pass = checks.every((c) => c.pass);
  await writeFile(
    report,
    JSON.stringify(
      {
        platform: process.platform,
        html: htmlOrigin ? "native" : "source",
        checks,
        pass,
        requests: requests.map(({ path, method, completed }) => ({ path, method, completed })),
        externalResourceCount: external.length
      },
      null,
      2
    ) + "\n"
  );
  console.log(
    JSON.stringify({
      platform: process.platform,
      html: htmlOrigin ? "native" : "source",
      passed: checks.filter((c) => c.pass).length,
      total: checks.length,
      pass
    })
  );
  if (!pass) process.exitCode = 1;
} catch (error) {
  await writeFile(
    report,
    JSON.stringify(
      {
        platform: process.platform,
        html: htmlOrigin ? "native" : "source",
        pass: false,
        checks,
        error: error.message
      },
      null,
      2
    ) + "\n"
  );
  throw error;
} finally {
  client?.close();
  if (chrome?.pid !== undefined && chrome.exitCode === null) {
    const stopped = once(chrome, "exit");
    chrome.kill("SIGTERM");
    await Promise.race([stopped, new Promise((r) => setTimeout(r, 2000))]);
    if (chrome.exitCode === null) {
      chrome.kill("SIGKILL");
      await stopped;
    }
  }
  await new Promise((r) => fixture.close(r));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
