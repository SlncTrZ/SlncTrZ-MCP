/** Native SEA smoke test — verify gateway bootstrap plus embedded assets. */

import { randomBytes, scryptSync } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeTarget =
  process.platform === "linux" && process.arch === "x64"
    ? "linux-x64"
    : process.platform === "win32" && process.arch === "x64"
      ? "win32-x64"
      : undefined;
if (nativeTarget === undefined) {
  throw new Error(`SEA smoke target is unsupported: ${process.platform}-${process.arch}`);
}
const requestedTarget = process.argv[2] ?? nativeTarget;
if (requestedTarget !== nativeTarget) {
  throw new Error(`SEA smoke target ${requestedTarget} must run on its native runner`);
}
const fileName = nativeTarget === "win32-x64" ? "slnctrz-mcp.exe" : "slnctrz-mcp";
const binary = join(root, "dist", "standalone", nativeTarget, fileName);
const salt = randomBytes(16);
const secret = randomBytes(32).toString("base64url");
const expected = scryptSync(secret, salt, 32, {
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024
});

async function reserveLoopbackPort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a loopback smoke-test port"));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolvePromise(port)));
    });
  });
}

const gatewayPort = await reserveLoopbackPort();
const verifier = [
  "scrypt",
  "16384",
  "8",
  "1",
  salt.toString("base64url"),
  expected.toString("base64url")
].join("$");

const stateRoot = await mkdtemp(join(tmpdir(), "slnctrz-sea-smoke-"));
const child = spawn(binary, [], {
  cwd: root,
  env: {
    PATH: process.env.PATH ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    WINDIR: process.env.WINDIR ?? "",
    SLNCTRZ_STATE_ROOT: stateRoot,
    SLNCTRZ_OWNER_SECRET_HASH: verifier,
    SLNCTRZ_PUBLIC_URL: "https://mcp.example.test/mcp",
    SLNCTRZ_HOST: "127.0.0.1",
    SLNCTRZ_PORT: String(gatewayPort),
    SLNCTRZ_CONTROL_HOST: "127.0.0.1",
    SLNCTRZ_CONTROL_PORT: "0"
  },
  stdio: ["ignore", "pipe", "pipe"],
  shell: false
});

let stdout = "";
let stderr = "";
let ready = false;
let checking = false;
const timeout = setTimeout(() => child.kill(), 15_000);

async function verifyEmbeddedAssets() {
  const match = /SlncTrZ-MCP listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/u.exec(stdout);
  if (match?.[1] === undefined) return;
  const response = await fetch(`http://127.0.0.1:${match[1]}/assets/fonts/SlncHertine.woff2`, {
    headers: { host: "127.0.0.1" }
  });
  const bytes = await response.arrayBuffer();
  if (
    !response.ok ||
    response.headers.get("content-type") !== "font/woff2" ||
    bytes.byteLength < 1_000
  ) {
    throw new Error("SEA embedded font asset smoke test failed");
  }
}

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  if (
    !checking &&
    stdout.includes("SlncTrZ-MCP listening on ") &&
    stdout.includes("SlncTrZ-MCP control plane listening on ")
  ) {
    checking = true;
    void verifyEmbeddedAssets().then(
      () => {
        ready = true;
        child.kill();
      },
      (error) => {
        stderr += `\n${error instanceof Error ? error.message : String(error)}`;
        child.kill();
      }
    );
  }
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

await new Promise((resolvePromise, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    clearTimeout(timeout);
    if (!ready) {
      reject(
        new Error(
          `SEA gateway smoke test failed before readiness (code=${String(code)}, signal=${String(signal)}): ${stderr}`
        )
      );
      return;
    }
    resolvePromise();
  });
}).finally(() => rm(stateRoot, { recursive: true, force: true }));

console.log(`SEA ${nativeTarget} gateway bootstrap + embedded asset smoke test passed`);
