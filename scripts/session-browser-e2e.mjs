/** Owner session/navigation browser matrix against real delivered HTML and isolated API fixtures. */
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
const baseline = process.env.SLNCTRZ_BROWSER_BASELINE === "1";
const { createOwnerWebConsole } = await import(
  baseline ? "../dist/owner/baseline/web-console.js" : "../dist/owner/web-console.js"
);
import { CdpClient, startBrowser } from "./lib/browser-cdp.mjs";

const [stage = "after", reportFile, htmlOrigin] = process.argv.slice(2);
if (htmlOrigin) {
  const url = new URL(htmlOrigin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
    throw new Error("Native fixture origin must be loopback HTTP");
}
let completed = false;
if (!reportFile)
  throw new Error("usage: node scripts/session-browser-e2e.mjs <before|after> <report-file>");
const reportPath = resolve(reportFile),
  records = [],
  requests = [];
const browserCommand =
  process.env.SLNCTRZ_BROWSER ||
  (process.platform === "win32"
    ? "C:/Program Files/Google/Chrome/Application/chrome.exe"
    : "google-chrome-stable");
const profile = await mkdtemp(join(tmpdir(), "slnctrz-wp05-browser-"));
const consolePage = createOwnerWebConsole({
  ownerSecretHash: "",
  policyStore: {},
  statePaths: {},
  mutation: {}
});
let scenario = {},
  chrome,
  client,
  origin;
function json(res, status, data) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}
const fixture = createServer(async (req, res) => {
  try {
    const active = { ...scenario };
    const path = new URL(req.url, origin || "http://127.0.0.1").pathname;
    requests.push({ path, at: Date.now(), method: req.method });
    if (path === "/owner/api/login") {
      scenario = { ...scenario, sessionStatus: 200 };
      json(res, 200, { authenticated: true, csrf: "" });
      return;
    }
    if (path === "/owner/api/session") {
      await new Promise((r) => setTimeout(r, active.delay || 0));
      if (active.network) {
        req.socket.destroy();
        return;
      }
      if (active.sessionStatus && active.sessionStatus !== 200) {
        json(res, active.sessionStatus, {
          error: { code: "fixture_error", message: "Fixture session unavailable" }
        });
        return;
      }
      if (active.invalidJson) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{");
        return;
      }
      json(res, 200, { authenticated: true, csrf: "" });
      return;
    }
    if (path.startsWith("/owner/api/")) {
      const range = new URL(req.url, origin).searchParams.get("range");
      if (active.race && range === "7d") await new Promise((r) => setTimeout(r, 400));
      const failure =
        req.method !== "GET" ? active.mutationStatus || 200 : active.dataStatus || 200;
      if (failure !== 200) {
        json(res, failure, {
          error: {
            code: failure === 403 ? "csrf_denied" : "fixture_error",
            message: "Fixture data unavailable"
          }
        });
        return;
      }
      if (path === "/owner/api/state") {
        json(res, 200, {
          authorityMode: "restricted",
          paths: [],
          commands: [],
          commandCatalog: { status: "ready" },
          mcpServers: [],
          connections: [],
          product: {}
        });
        return;
      }
      if (path === "/owner/api/debates") {
        json(
          res,
          200,
          active.debateRows
            ? [
                {
                  debateId: "fixture-debate",
                  topic: "Fixture debate",
                  status: "waiting",
                  completedTurns: 0,
                  maxTurns: 2
                }
              ]
            : []
        );
        return;
      }
      if (path === "/owner/api/debates/fixture-debate") {
        json(res, 200, {
          debateId: "fixture-debate",
          topic: "Fixture debate",
          status: "waiting",
          messages: [],
          participants: [],
          maxTurns: 2
        });
        return;
      }
      if (path.endsWith("/timeseries") || path.endsWith("/tools")) {
        json(res, 200, []);
        return;
      }
      json(res, 200, {
        estimatedTotalTokens: 0,
        estimatedOutputTokens: 0,
        calls: active.race ? (range === "7d" ? 7 : 30) : 0,
        estimatorId: "utf8-bytes-v1",
        avoidedEstimatedTokens: 0,
        reductionPercent: 0,
        potentialEagerEstimatedTokens: 0,
        disclosedEstimatedTokens: 0,
        contexts: 0,
        degraded: false
      });
      return;
    }
    if (htmlOrigin) {
      const response = await fetch(htmlOrigin + path, { redirect: "manual" });
      const content = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, {
        "content-type": response.headers.get("content-type") || "application/octet-stream",
        "cache-control": "no-store"
      });
      res.end(content);
      return;
    }
    if (await consolePage.handle(req, res, path)) return;
    res.writeHead(404);
    res.end();
  } catch {
    if (!res.writableEnded) {
      res.writeHead(500);
      res.end();
    }
  }
});
function assert(record, key, value) {
  record.checks[key] = !!value;
}
async function capture(label, path, config) {
  scenario = { ...config };
  const start = requests.length;
  await client.navigate(origin + path);
  await client.poll("document.readyState==='complete'");
  await new Promise((r) => setTimeout(r, (config.delay || 0) + 200));
  const state = await client.evaluate(`(()=>{
 const visible=id=>{const e=document.getElementById(id);return !!e&&!e.hidden&&getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden'};
 return {login:visible('login')||visible('auth-required'),app:visible('app')||visible('dashboard'),status:document.getElementById('owner-session-status')?.dataset.state||null,trace:window.__wp05Trace,url:location.pathname+location.hash,error:visible('usage-error')||visible('page-error')||visible('owner-session-status')};
})()`);
  const record = {
    label,
    path,
    configuration: config,
    observed: state,
    checks: {},
    requests: requests.slice(start).map((x) => ({ path: x.path, method: x.method })),
    durationMs: 0
  };
  records.push(record);
  const invalid =
    (!!config.sessionStatus && config.sessionStatus !== 200) ||
    config.network ||
    config.invalidJson;
  if (config.sessionStatus === 401) {
    assert(record, "signInAfter401", state.login && !state.app);
  } else if (invalid) {
    assert(record, "sessionErrorKeepsSignInHidden", !state.login && !state.app && state.error);
  } else if (config.dataStatus === 401) {
    assert(record, "expiredDataLocksApp", state.login && !state.app);
  } else {
    assert(record, "noLoginFlash", !state.trace.loginEverVisible);
    assert(record, "authenticatedShellVisible", state.app && !state.login);
    if (config.dataStatus) assert(record, "dataErrorDisplayed", state.error);
  }
  if (label === "slow-valid" || label === "session-500" || label === "data-500") {
    const screenshot = await client.send("Page.captureScreenshot", { format: "png" });
    await writeFile(
      join(
        resolve(reportPath, ".."),
        process.platform +
          "-" +
          (htmlOrigin ? "native" : "source") +
          "-" +
          stage +
          "-" +
          path.replaceAll("/", "").replaceAll("#", "-") +
          "-" +
          label +
          ".png"
      ),
      Buffer.from(screenshot.data, "base64")
    );
  }
  if (
    stage === "after" &&
    ((invalid && config.sessionStatus !== 401) || config.dataStatus === 500)
  ) {
    scenario = {};
    const retriesBefore = requests.filter((x) => x.path === "/owner/api/session").length;
    await client.evaluate(
      "document.getElementById('owner-session-retry').click();document.getElementById('owner-session-retry').click()"
    );
    await client.poll("document.getElementById('owner-session-status')?.dataset.state==='ready'");
    const recovered = await client.evaluate(
      "!document.getElementById('owner-session-status')?.classList.contains('hidden')"
    );
    assert(record, "retryRecovers", !recovered);
    assert(
      record,
      "retryDeduplicates",
      requests.filter((x) => x.path === "/owner/api/session").length === retriesBefore + 1
    );
  }
  record.durationMs = state.trace.transitions.at(-1)?.at ?? 0;
  return record;
}
try {
  fixture.listen({ host: "127.0.0.1", port: 0 });
  await once(fixture, "listening");
  origin = "http://127.0.0.1:" + fixture.address().port;
  const started = await startBrowser(browserCommand, profile);
  chrome = started.child;
  const port = new URL(started.browserWs).port,
    target = await (
      await fetch("http://127.0.0.1:" + port + "/json/new?about:blank", { method: "PUT" })
    ).json();
  client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }]
  });
  await client.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__wp05Trace={loginEverVisible:false,transitions:[]};let last='';
 function scan(){const visible=id=>{const e=document.getElementById(id);return !!e&&!e.hidden&&getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden'};
 const login=visible('login')||visible('auth-required'),app=visible('app')||visible('dashboard'),status=document.getElementById('owner-session-status')?.dataset.state||null;
 window.__wp05Trace.loginEverVisible ||= login;const key=JSON.stringify({login,app,status});if(key!==last){last=key;window.__wp05Trace.transitions.push({at:Math.round(performance.now()),login,app,status})}
 requestAnimationFrame(scan)}requestAnimationFrame(scan);`
  });
  for (const path of ["/", "/usage", "/debate"]) {
    for (const [label, config] of [
      ["slow-valid", { delay: 500 }],
      ["session-401", { sessionStatus: 401 }],
      ["session-500", { sessionStatus: 500 }],
      ["session-429", { sessionStatus: 429 }],
      ["session-network", { network: true }],
      ["session-json", { invalidJson: true }],
      ["data-500", { dataStatus: 500 }],
      ["data-401", { dataStatus: 401 }]
    ]) {
      await capture(label, path, config);
    }
  }
  scenario = {};
  await client.navigate(origin + "/#mcp");
  await new Promise((r) => setTimeout(r, 150));
  const navStart = requests.filter((x) => x.path === "/").length;
  await client.evaluate("document.querySelector('[data-section=overview]').click()");
  await new Promise((r) => setTimeout(r, 150));
  let state = await client.evaluate(
    "({path:location.pathname,hash:location.hash,title:document.getElementById('dashboard-title').textContent,selected:document.querySelector('[data-section=overview]').getAttribute('aria-current')})"
  );
  records.push({
    label: "owner-overview-navigation",
    observed: state,
    checks: {
      noDocumentReload: requests.filter((x) => x.path === "/").length === navStart,
      overviewSelected: state.title === "Overview" && state.selected === "page"
    }
  });
  for (const route of ["/owner", "#connections", "#mcp", "#access", "#settings"]) {
    if (route === "/owner") await client.navigate(origin + route);
    else
      await client.evaluate(
        "document.querySelector('[data-section=" + route.slice(1) + "]').click()"
      );
    await new Promise((r) => setTimeout(r, 100));
    const routeState = await client.evaluate(
      "({path:location.pathname,hash:location.hash,title:document.getElementById('dashboard-title').textContent,selected:document.querySelector('.dashboard-nav [aria-current=page]').dataset.section})"
    );
    records.push({
      label: "alias-" + route,
      observed: routeState,
      checks: {
        aliasRetained: routeState.path === "/owner",
        selectedMatches:
          route === "/owner"
            ? routeState.selected === "overview"
            : routeState.selected === route.slice(1)
      }
    });
  }
  if (stage === "after") {
    await client.evaluate("history.back()");
    await client.poll(
      "location.hash==='#access'&&document.querySelector('[data-section=access]').getAttribute('aria-current')==='page'"
    );
    await client.evaluate("history.forward()");
    await client.poll(
      "location.hash==='#settings'&&document.querySelector('[data-section=settings]').getAttribute('aria-current')==='page'"
    );
    records.push({ label: "back-forward", checks: { selectedTracksHistory: true } });
  }
  for (const path of ["/usage", "/debate"]) {
    await client.navigate(origin + path);
    await new Promise((r) => setTimeout(r, 100));
    await client.evaluate("document.querySelector('[data-section=overview]').click()");
    await new Promise((r) => setTimeout(r, 150));
    const seen = await client.evaluate("window.__wp05Trace");
    records.push({
      label: path + "-to-overview",
      checks: { noLoginFlash: !seen.loginEverVisible },
      observed: seen
    });
  }
  if (stage === "after") {
    scenario = { mutationStatus: 403 };
    await client.navigate(origin + "/#access");
    await client.poll("document.getElementById('owner-session-status').dataset.state==='ready'");
    const start = requests.length;
    await client.evaluate("document.getElementById('set-authority').click()");
    await client.poll(
      "document.getElementById('owner-session-status').dataset.state==='data-error'"
    );
    const mutationState = await client.evaluate(
      "({app:!document.getElementById('app').classList.contains('hidden'),login:!document.getElementById('login').classList.contains('hidden'),message:document.getElementById('owner-session-message').textContent})"
    );
    await client.evaluate("document.getElementById('owner-session-retry').click()");
    await client.poll("document.getElementById('owner-session-status').dataset.state==='ready'");
    records.push({
      label: "owner-csrf-403",
      observed: mutationState,
      checks: {
        keepsAuthenticatedApp: mutationState.app && !mutationState.login,
        recoveryMessage: mutationState.message.includes("try the action again"),
        noMutationReplay: requests.slice(start).filter((x) => x.method !== "GET").length === 1
      }
    });
    scenario = { debateRows: true, mutationStatus: 403 };
    await client.navigate(origin + "/debate");
    await client.poll(
      "!document.getElementById('stop-action').disabled&&document.getElementById('owner-session-status').dataset.state==='ready'"
    );
    await client.evaluate("document.getElementById('stop-action').click()");
    await client.poll(
      "document.getElementById('owner-session-status').dataset.state==='data-error'"
    );
    const debateState = await client.evaluate(
      "({app:!document.getElementById('app').classList.contains('hidden'),login:!document.getElementById('auth-required').classList.contains('hidden')})"
    );
    records.push({
      label: "debate-csrf-403",
      observed: debateState,
      checks: { keepsAuthenticatedApp: debateState.app && !debateState.login }
    });
    scenario = {};
    await client.navigate(origin + "/usage");
    await client.poll("document.getElementById('owner-session-status').dataset.state==='ready'");
    scenario = { dataStatus: 500 };
    await client.evaluate("document.querySelector('[data-range=\"7d\"]').click()");
    await client.poll(
      "document.getElementById('owner-session-status').dataset.state==='data-error'"
    );
    scenario = { race: true };
    await client.evaluate("document.getElementById('owner-session-retry').click()");
    await client.poll("document.getElementById('owner-session-status').dataset.state==='ready'");
    const usageStart = requests.length;
    await client.evaluate(
      "document.querySelector('[data-range=\"7d\"]').click();document.querySelector('[data-range=\"30d\"]').click()"
    );
    await new Promise((r) => setTimeout(r, 600));
    const race = await client.evaluate(
      "({calls:document.getElementById('calls').textContent,active:document.querySelector('#range button.active').dataset.range,error:document.getElementById('owner-session-status').dataset.state})"
    );
    records.push({
      label: "usage-rapid-range-after-retry",
      observed: race,
      checks: {
        latestRangeWins: race.active === "30d" && race.calls.startsWith("30 "),
        singleRangeListener:
          requests.slice(usageStart).filter((x) => x.path.startsWith("/owner/api/usage/"))
            .length === 10
      }
    });
    scenario = {};
    await client.navigate(origin + "/owner#settings");
    await client.poll("document.getElementById('owner-session-status').dataset.state==='ready'");
    const historySessionStart = requests.filter((x) => x.path === "/owner/api/session").length;
    await client.navigate(origin + "/usage");
    await client.poll("document.getElementById('owner-session-status').dataset.state==='ready'");
    await client.evaluate("history.back()");
    await client.poll(
      "location.pathname==='/owner'&&location.hash==='#settings'&&document.getElementById('owner-session-status').dataset.state==='ready'"
    );
    const restored = await client.evaluate(
      "({status:document.getElementById('owner-session-status').dataset.state,login:window.__wp05Trace.loginEverVisible,title:document.getElementById('dashboard-title').textContent})"
    );
    records.push({
      label: "document-back-rechecks-session",
      observed: restored,
      checks: {
        sessionRechecked:
          requests.filter((x) => x.path === "/owner/api/session").length >= historySessionStart + 2,
        noLoginFlash: !restored.login,
        selectedMatches: restored.title === "Settings"
      }
    });
    await client.send("Page.reload");
    await client.poll(
      "document.getElementById('owner-session-status').dataset.state==='ready'&&document.getElementById('dashboard-title').textContent==='Settings'"
    );
    records.push({ label: "direct-reload-deep-link", checks: { selectedMatches: true } });
  }
  if (stage === "after") {
    scenario = { sessionStatus: 401 };
    await client.navigate(origin + "/");
    await client.poll(
      "document.getElementById('owner-session-status').dataset.state==='unauthenticated'"
    );
    await client.evaluate("document.getElementById('signin').click()");
    await client.poll("document.getElementById('owner-session-status').dataset.state==='ready'");
    const loginState = await client.evaluate(
      "({login:!document.getElementById('login').classList.contains('hidden'),app:!document.getElementById('app').classList.contains('hidden'),error:document.getElementById('login-error').textContent})"
    );
    records.push({
      label: "sign-in-after-401",
      observed: loginState,
      checks: { signInRecovers: loginState.app && !loginState.login && !loginState.error }
    });
  }

  completed = true;
} finally {
  client?.close();
  if (chrome && chrome.exitCode === null) {
    const stopped = once(chrome, "exit");
    chrome.kill("SIGTERM");
    await Promise.race([stopped, new Promise((r) => setTimeout(r, 2000))]);
    if (chrome.exitCode === null) {
      chrome.kill("SIGKILL");
      await stopped;
    }
  }
  fixture.closeAllConnections();
  await new Promise((r) => fixture.close(r));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const failures = records.flatMap((r) =>
    Object.entries(r.checks)
      .filter(([, v]) => !v)
      .map(([key]) => ({ label: r.label, path: r.path, check: key }))
  );
  const report = {
    stage,
    completed,
    htmlSource: htmlOrigin ? "native artifact" : baseline ? "baseline snapshot" : "source build",
    platform: process.platform,
    node: process.version,
    browser: browserCommand,
    records,
    failures,
    cleanup: { profileRemoved: true, fixtureClosed: true }
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      stage,
      platform: process.platform,
      scenarios: records.length,
      failures: failures.length,
      report: reportPath
    })
  );
  if (stage === "after" && failures.length) process.exitCode = 1;
}
