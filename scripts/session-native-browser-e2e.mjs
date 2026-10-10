/** Verify the Owner browser matrix using HTML served by the exact local SEA artifact. */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, scryptSync, createHash } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { reserveLoopbackPort } from "./lib/browser-cdp.mjs";
import { createOwnerWebConsole } from "../dist/owner/web-console.js";
const report = resolve(process.argv[2] || "native-browser.json"),
  root = process.cwd();
const target = process.platform === "win32" ? "win32-x64" : "linux-x64",
  binary = join(
    root,
    "dist",
    "standalone",
    target,
    process.platform === "win32" ? "slnctrz-mcp.exe" : "slnctrz-mcp"
  );
const state = await mkdtemp(join(tmpdir(), "slnctrz-wp05-native-state-")),
  work = await mkdtemp(join(tmpdir(), "slnctrz-wp05-native-work-"));
const port = await reserveLoopbackPort(),
  controlPort = await reserveLoopbackPort(),
  htmlHashes = {},
  salt = randomBytes(16),
  secret = randomBytes(32),
  hash = scryptSync(secret, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const verifier = [
  "scrypt",
  "16384",
  "8",
  "1",
  salt.toString("base64url"),
  hash.toString("base64url")
].join("$");
let child,
  output = "",
  ready = false,
  spawnFailed = false;
try {
  child = spawn(binary, [], {
    cwd: work,
    env: {
      PATH: process.env.PATH || "",
      SystemRoot: process.env.SystemRoot || "",
      WINDIR: process.env.WINDIR || "",
      SLNCTRZ_STATE_ROOT: state,
      SLNCTRZ_OWNER_SECRET_HASH: verifier,
      SLNCTRZ_PUBLIC_URL: "https://mcp.example.test/mcp",
      SLNCTRZ_OWNER_WEB_ENABLED: "true",
      SLNCTRZ_HOST: "127.0.0.1",
      SLNCTRZ_PORT: String(port),
      SLNCTRZ_CONTROL_HOST: "127.0.0.1",
      SLNCTRZ_CONTROL_PORT: String(controlPort)
    },
    stdio: ["ignore", "pipe", "ignore"]
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output = (output + chunk).slice(-16384);
    ready = /SlncTrZ-MCP listening on http:\/\/127\.0\.0\.1:/u.test(output);
  });
  child.on("error", () => {
    spawnFailed = true;
  });
  const deadline = Date.now() + 15000;
  while (!ready && Date.now() < deadline) {
    if (spawnFailed) throw new Error("Native fixture could not start");
    if (child.exitCode !== null) throw new Error("Native fixture exited before readiness");
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!ready) throw new Error("Native fixture readiness timed out");
  const origin = "http://127.0.0.1:" + port;
  const sourcePage = createOwnerWebConsole({
    ownerSecretHash: "",
    policyStore: {},
    statePaths: {},
    mutation: {}
  });
  for (const path of ["/", "/owner", "/usage", "/debate"]) {
    const response = await fetch(origin + path);
    const nativeHtml = await response.text();
    let sourceHtml, sourceStatus;
    await sourcePage.handle(
      { method: "GET" },
      {
        writeHead(status) {
          sourceStatus = status;
        },
        end(content) {
          sourceHtml = content;
        }
      },
      path
    );
    const fingerprint = (content) => createHash("sha256").update(content).digest("hex");
    if (
      !response.ok ||
      sourceStatus !== response.status ||
      !nativeHtml.includes('id="owner-session-status"') ||
      fingerprint(nativeHtml) !== fingerprint(sourceHtml)
    )
      throw new Error(
        "Native/source Owner HTML identity mismatch " +
          JSON.stringify({
            path,
            status: response.status,
            sourceStatus,
            marker: nativeHtml.includes('id="owner-session-status"'),
            nativeBytes: nativeHtml.length,
            sourceBytes: sourceHtml.length,
            nativeTitle: /<title>([^<]+)<\/title>/.exec(nativeHtml)?.[1],
            sourceTitle: /<title>([^<]+)<\/title>/.exec(sourceHtml)?.[1]
          })
      );
    htmlHashes[path] = fingerprint(nativeHtml);
  }
  const run = spawnSync(
    process.execPath,
    ["scripts/session-browser-e2e.mjs", "after", report, origin],
    { cwd: root, env: process.env, encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 }
  );
  // Never forward gateway output, secrets, cookies or fixture verifier values.
  console.log(run.stdout.trim());
  if (run.status !== 0) {
    console.error("Native browser matrix failed");
    process.exitCode = 1;
  }
  const dashboardReport = report.replace(/\.json$/u, "") + "-dashboard.json";
  const dashboardRun = spawnSync(
    process.execPath,
    ["scripts/dashboard-browser-e2e.mjs", dashboardReport, origin],
    { cwd: root, env: process.env, encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 }
  );
  console.log(dashboardRun.stdout.trim());
  if (dashboardRun.status !== 0) {
    console.error("Native dashboard behavior matrix failed");
    process.exitCode = 1;
  }
  const record = JSON.parse(await readFile(report, "utf8"));
  if (dashboardRun.status === 0)
    record.dashboard = JSON.parse(await readFile(dashboardReport, "utf8"));
  record.nativeArtifact = {
    target,
    htmlHashes,
    sha256: createHash("sha256")
      .update(await readFile(binary))
      .digest("hex")
  };
  await writeFile(report, JSON.stringify(record, null, 2) + "\n");
} finally {
  if (child?.pid !== undefined && child.exitCode === null) {
    const stopped = once(child, "exit");
    child.kill("SIGTERM");
    await Promise.race([stopped, new Promise((r) => setTimeout(r, 2000))]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await stopped;
    }
  }
  await rm(state, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
