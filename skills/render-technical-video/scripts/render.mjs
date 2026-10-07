#!/usr/bin/env node
// Deterministic web-to-video capture. CDP pattern adapted from scripts/usage-browser-e2e.mjs.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile, realpath, stat, readdir } from "node:fs/promises";
import { tmpdir, platform, release, arch } from "node:os";
import { dirname, join, resolve, relative, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const hash = (data) => createHash("sha256").update(data).digest("hex");
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const args = process.argv.slice(2);
const preflight = args.length === 1 && args[0] === "--preflight";
const preview = args[2] === "--preview";
assert(
  preflight || args.length === 2 || (args.length === 3 && preview),
  "Usage: node render.mjs --preflight | <local.html> <NEW-output-directory> [--preview]"
);
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
assert(
  typeof WebSocket === "function" && (nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13)),
  "Use Node 22.13+ with built-in WebSocket"
);

function version(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 10000 });
  if (result.status !== 0) return null;
  return result.stdout.trim().split("\n")[0];
}
const browser = [
  process.env.VIDEO_BROWSER,
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable"
]
  .filter(Boolean)
  .find((command) => version(command));
assert(browser, "Chromium/Chrome missing; set VIDEO_BROWSER to its executable");
const versions = {
  node: process.version,
  browser: version(browser),
  os: `${platform()} ${release()} ${arch()}`
};
for (const command of ["ffmpeg", "ffprobe"]) {
  const result = spawnSync(command, ["-version"], { encoding: "utf8", timeout: 10000 });
  assert(result.status === 0, `${command} missing`);
  versions[command] = result.stdout.split("\n")[0];
}
if (preflight) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        versions,
        note: "Executable check only; render validates browser launch and libx264."
      },
      null,
      2
    )
  );
  process.exit(0);
}

// Bound command time and reject all pending calls when a browser disconnects.
class CdpClient {
  nextId = 1;
  pending = new Map();
  errors = [];
  async connect(url) {
    this.socket = new WebSocket(url);
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connection timeout")), 10000);
      this.socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolvePromise();
        },
        { once: true }
      );
      this.socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("CDP connection failed"));
        },
        { once: true }
      );
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const call = this.pending.get(message.id);
      if (call) {
        this.pending.delete(message.id);
        clearTimeout(call.timer);
        if (message.error) call.reject(new Error(`CDP ${call.method} failed`));
        else call.resolve(message.result ?? {});
      }
      if (message.method === "Runtime.exceptionThrown") this.errors.push("Uncaught page exception");
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error")
        this.errors.push("Page console.error");
      if (message.method === "Network.loadingFailed") this.errors.push("Page resource load failed");
      if (message.method === "Network.responseReceived" && message.params.response.status >= 400)
        this.errors.push("Page resource HTTP error");
    });
    this.socket.addEventListener("close", () => {
      for (const call of this.pending.values()) {
        clearTimeout(call.timer);
        call.reject(new Error("CDP disconnected"));
      }
      this.pending.clear();
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30000);
      this.pending.set(id, { resolve: resolvePromise, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 25000
    });
    assert(
      !result.exceptionDetails,
      "Page evaluation failed; inspect the authored source and its readiness/layout contract"
    );
    return result.result?.value;
  }
  check() {
    assert(!this.errors.length, this.errors.slice(0, 3).join("; "));
  }
  close() {
    this.socket?.close();
  }
}

function validateMeta(meta) {
  assert(meta && typeof meta === "object", "Missing video.meta");
  for (const [key, min, max] of [
    ["width", 320, 3840],
    ["height", 180, 3840],
    ["fps", 1, 60]
  ]) {
    assert(Number.isInteger(meta[key]) && meta[key] >= min && meta[key] <= max, `Invalid ${key}`);
  }
  assert(meta.width * meta.height <= 3840 * 2160, "Frame exceeds 4K pixel budget");
  assert(meta.width % 2 === 0 && meta.height % 2 === 0, "H.264 dimensions must be even");
  assert(
    Number.isFinite(meta.duration) && meta.duration > 0 && meta.duration <= 600,
    "Invalid duration"
  );
  const count = Math.round(meta.duration * meta.fps);
  assert(
    count >= 1 && count <= 18000 && Math.abs(count - meta.duration * meta.fps) < 1e-7,
    "Duration must contain an integral bounded frame count"
  );
  assert(
    Array.isArray(meta.scenes) && meta.scenes.length >= 1 && meta.scenes.length <= 100,
    "Invalid scenes"
  );
  let end = 0;
  for (const scene of meta.scenes) {
    assert(
      typeof scene.name === "string" && scene.name.length > 0 && scene.name.length <= 120,
      "Invalid scene name"
    );
    assert(
      Number.isFinite(scene.start) &&
        Number.isFinite(scene.end) &&
        Math.abs(scene.start - end) < 1e-7 &&
        scene.end > scene.start,
      "Scenes must be contiguous"
    );
    end = scene.end;
  }
  assert(Math.abs(end - meta.duration) < 1e-7, "Scenes must cover duration");
  return count;
}

async function run(command, argv) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, argv, { stdio: ["ignore", "ignore", "ignore"] });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timeout`));
    }, 300000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error(`${command} launch failed`));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} failed (${code})`));
    });
  });
}

const input = await realpath(resolve(args[0]));
assert(
  extname(input).toLowerCase() === ".html" && (await stat(input)).isFile(),
  "Input must be a local HTML file"
);
const root = dirname(input);
const output = resolve(args[1]);
await mkdir(dirname(output), { recursive: true });
await mkdir(output); // EEXIST deliberately prevents overwriting previous work.
const assets = new Map();
const server = createServer(async (req, res) => {
  try {
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (pathname === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }
    const target = await realpath(resolve(root, "." + pathname));
    const rel = relative(root, target);
    assert(
      rel &&
        rel !== ".." &&
        !rel.startsWith(".." + sep) &&
        !resolve(root, rel).startsWith(output + sep),
      "Outside asset root"
    );
    const info = await stat(target);
    assert(info.isFile() && info.size <= 32 * 1024 * 1024, "Asset invalid or too large");
    const data = await readFile(target);
    assets.set(rel.replaceAll(sep, "/"), hash(data));
    const type =
      {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".ttf": "font/ttf",
        ".woff2": "font/woff2",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".svg": "image/svg+xml",
        ".json": "application/json"
      }[extname(target).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-src 'none'; worker-src 'none'; media-src 'none'; object-src 'none'"
    });
    res.end(data);
  } catch {
    res.writeHead(404).end("Asset unavailable");
  }
});
let chrome, client, profile;
const startedAt = performance.now();
const latencies = [];
try {
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const origin = `http://127.0.0.1:${server.address().port}`;
  profile = await mkdtemp(join(tmpdir(), "technical-video-"));
  chrome = spawn(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--force-color-profile=srgb",
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profile}`,
      "about:blank"
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  const browserWs = await new Promise((resolvePromise, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error("Chromium startup timeout")), 15000);
    chrome.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Chromium launch failed"));
    });
    chrome.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Chromium exited during launch; check sandbox/runtime support"));
    });
    chrome.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-8192);
      const match = /DevTools listening on (ws:\/\/[^\s]+)/u.exec(stderr);
      if (match) {
        clearTimeout(timer);
        resolvePromise(match[1]);
      }
    });
  });
  const port = new URL(browserWs).port;
  const targetResponse = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
    method: "PUT",
    signal: AbortSignal.timeout(10000)
  });
  assert(targetResponse.ok, "Unable to create Chromium target");
  client = new CdpClient();
  await client.connect((await targetResponse.json()).webSocketDebuggerUrl);
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Network.enable");
  // Fetch interception permits only the asset server, including CSS/font subresources.
  await client.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  client.socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method !== "Fetch.requestPaused") return;
    const { requestId, request } = message.params;
    const allowed = request.url.startsWith(origin + "/") || request.url.startsWith("data:");
    if (!allowed) client.errors.push("External resource blocked");
    void client
      .send(
        allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
        allowed ? { requestId } : { requestId, errorReason: "BlockedByClient" }
      )
      .catch(() => {
        client.errors.push("Resource interception failed");
      });
  });
  await client.send("Network.setBlockedURLs", { urls: ["ws://*", "wss://*"] });
  await client.send("Page.navigate", {
    url: origin + "/" + encodeURIComponent(relative(root, input))
  });
  const deadline = Date.now() + 15000;
  while (!(await client.evaluate("document.readyState === 'complete' && !!window.video"))) {
    assert(Date.now() < deadline, "Page/video contract unavailable");
    await delay(50);
  }
  await client.evaluate(
    "(async()=>{if(!video.ready || typeof video.ready.then !== 'function')throw Error('Missing ready promise');await video.ready;await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode()));return true})()"
  );
  const meta = await client.evaluate("video.meta");
  const count = validateMeta(meta);
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: meta.width,
    height: meta.height,
    deviceScaleFactor: 1,
    mobile: false
  });
  await client.evaluate(`(() => {
    const style = document.createElement('style');
    style.textContent = 'html,body{margin:0!important;padding:0!important;width:100%!important;height:100%!important;overflow:hidden!important;scrollbar-gutter:auto!important}';
    document.head.append(style);
    return true;
  })()`);
  const checkFrame = `(() => {
    const w=${meta.width}, h=${meta.height}, root=document.documentElement;
    if(innerWidth!==w||innerHeight!==h||devicePixelRatio!==1||root.clientWidth!==w||root.clientHeight!==h)
      throw Error('Viewport mismatch');
    for(const el of [root,document.body])
      if(el.scrollWidth>w||el.scrollHeight>h)throw Error('Content exceeds output frame');
    for(const el of document.querySelectorAll('*')){
      if(!el.getClientRects().length)continue;
      const css=getComputedStyle(el);
      if(css.visibility==='hidden'||Number(css.opacity)===0)continue;
      if(css.overflowX==='scroll'||css.overflowY==='scroll'||
         (css.overflowX==='auto'&&el.scrollWidth>el.clientWidth)||
         (css.overflowY==='auto'&&el.scrollHeight>el.clientHeight))
        throw Error('Visible scroll container in video');
    }
    const stage=document.getElementById('stage');
    if(stage){
      const b=stage.getBoundingClientRect();
      if(Math.abs(b.x)>.5||Math.abs(b.y)>.5||Math.abs(b.width-w)>.5||Math.abs(b.height-h)>.5)
        throw Error('Stage must fill output frame');
      if(stage instanceof HTMLCanvasElement&&(stage.width!==w||stage.height!==h))
        throw Error('Canvas backing pixels must match output');
    }
    return true;
  })()`;
  const capture = async (index) => {
    const start = performance.now();
    await client.evaluate(
      `(async()=>{await video.render(${index / meta.fps});const errors=typeof video.validate==='function'?await video.validate():[];if(!Array.isArray(errors)||errors.length)throw Error('Layout validation failed');if(document.getAnimations().some(a=>a.playState==='running'||a.pending))throw Error('Autonomous animation');return true})()`
    );
    await client.evaluate(checkFrame);
    client.check();
    const shot = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false
    });
    const data = Buffer.from(shot.data, "base64");
    assert(
      data.readUInt32BE(16) === meta.width && data.readUInt32BE(20) === meta.height,
      "Screenshot dimensions mismatch"
    );
    latencies.push(performance.now() - start);
    return data;
  };
  const sampleSet = new Set([0, count - 1]);
  for (const scene of meta.scenes) {
    for (const t of [scene.start, (scene.start + scene.end) / 2, scene.end]) {
      const i = Math.round(t * meta.fps);
      for (const offset of [-1, 0, 1]) sampleSet.add(Math.max(0, Math.min(count - 1, i + offset)));
    }
  }
  const indices = [...sampleSet].sort((a, b) => a - b);
  const samples = [];
  for (const [n, index] of indices.entries()) {
    const data = await capture(index);
    await writeFile(join(output, `preview-${String(n).padStart(3, "0")}.png`), data);
    samples.push({ index, time: index / meta.fps, sha256: hash(data) });
  }
  for (const sample of [...samples].reverse())
    assert(
      hash(await capture(sample.index)) === sample.sha256,
      `Non-deterministic reverse seek at frame ${sample.index}`
    );
  await delay(150);
  const delayed = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false
  });
  assert(
    hash(Buffer.from(delayed.data, "base64")) === samples[0].sha256,
    "Wall-clock drift without render(t)"
  );
  const estimateSeconds = (count * latencies.reduce((a, b) => a + b, 0)) / latencies.length / 1000;
  console.log(
    JSON.stringify({
      stage: "samples-pass",
      samples: samples.length,
      frames: count,
      estimatedCaptureSeconds: Math.round(estimateSeconds)
    })
  );
  await run("ffmpeg", [
    "-v",
    "error",
    "-nostdin",
    "-n",
    "-framerate",
    "1",
    "-i",
    join(output, "preview-%03d.png"),
    "-vf",
    `scale=384:-1,tile=4x${Math.ceil(samples.length / 4)}:padding=8:margin=8:color=0x0b1320`,
    "-frames:v",
    "1",
    "-threads",
    "2",
    "-q:v",
    "2",
    join(output, "contact-sheet.jpg")
  ]);
  let probe = null,
    videoHash = null;
  if (!preview) {
    const frames = join(output, "frames");
    await mkdir(frames);
    for (let i = 0; i < count; i++) {
      await writeFile(join(frames, `${String(i).padStart(6, "0")}.png`), await capture(i));
      if (i % meta.fps === 0)
        console.log(JSON.stringify({ stage: "capture", frame: i, total: count }));
    }
    assert((await readdir(frames)).length === count, "Frame sequence incomplete");
    await run("ffmpeg", [
      "-v",
      "error",
      "-nostdin",
      "-n",
      "-framerate",
      String(meta.fps),
      "-start_number",
      "0",
      "-i",
      join(frames, "%06d.png"),
      "-frames:v",
      String(count),
      "-an",
      "-c:v",
      "libx264",
      "-threads",
      "2",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(meta.fps),
      "-movflags",
      "+faststart",
      join(output, "video.mp4")
    ]);
    const result = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-count_frames",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,codec_name,pix_fmt,avg_frame_rate,nb_read_frames,duration",
        "-of",
        "json",
        join(output, "video.mp4")
      ],
      { encoding: "utf8", timeout: 30000 }
    );
    assert(result.status === 0, "ffprobe failed");
    probe = JSON.parse(result.stdout).streams[0];
    const [num, den] = probe.avg_frame_rate.split("/").map(Number);
    assert(
      probe.width === meta.width &&
        probe.height === meta.height &&
        probe.codec_name === "h264" &&
        probe.pix_fmt === "yuv420p" &&
        num / den === meta.fps &&
        Number(probe.nb_read_frames) === count &&
        Math.abs(Number(probe.duration) - meta.duration) < 1 / meta.fps,
      "Encoded video contract mismatch"
    );
    videoHash = hash(await readFile(join(output, "video.mp4")));
  }
  client.check();
  // Catch input changes during rendering; output must describe a single asset revision.
  for (const [name, expected] of assets)
    assert(
      hash(await readFile(join(root, name))) === expected,
      "An input asset changed during rendering"
    );
  const sorted = [...latencies].sort((a, b) => a - b);
  const report = {
    schemaVersion: 1,
    mode: preview ? "preview" : "full",
    technicalPass: true,
    visualReview: "required",
    meta,
    frames: count,
    versions,
    rendererSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    assets: Object.fromEntries(assets),
    samples,
    determinism: { reverseSeek: true, delayedRepeat: true },
    estimatedCaptureSeconds: estimateSeconds,
    latencyMs: {
      mean: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      p95: sorted[Math.ceil(sorted.length * 0.95) - 1]
    },
    elapsedSeconds: (performance.now() - startedAt) / 1000,
    probe,
    videoSha256: videoHash
  };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      stage: "complete",
      mode: report.mode,
      frames: count,
      elapsedSeconds: Math.round(report.elapsedSeconds),
      visualReview: "required"
    })
  );
} finally {
  client?.close();
  chrome?.kill("SIGTERM");
  server.closeAllConnections();
  server.close();
  // Keep the fresh profile for diagnostics; never recursively delete caller-owned paths.
}
