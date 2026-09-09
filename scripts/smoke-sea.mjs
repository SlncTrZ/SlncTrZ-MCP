/** Native SEA smoke test — verify gateway bootstrap plus embedded assets. */

import { createHash, randomBytes, scryptSync } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const workRoot = await mkdtemp(join(tmpdir(), "slnctrz-sea-work-"));
await writeFile(join(workRoot, "probe.txt"), "packaged-harness-read");
const child = spawn(binary, [], {
  cwd: workRoot,
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
const timeout = setTimeout(() => child.kill(), 30_000);

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
  await verifyPackagedHarness(`http://127.0.0.1:${match[1]}`);
}

async function verifyPackagedHarness(origin) {
  const resource = "https://mcp.example.test/mcp";
  const redirectUri = "https://sea-client.example.test/callback";
  const registered = await fetch(`${origin}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none" })
  });
  if (registered.status !== 201) throw new Error("SEA OAuth registration failed");
  const client = await registered.json();
  const verifier = "v".repeat(43);
  const query = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource,
    scope: "mcp:tools"
  });
  const page = await fetch(`${origin}/authorize?${query}`);
  const transaction = /name="transaction_id" value="([^"]+)"/u.exec(await page.text())?.[1];
  if (!transaction) throw new Error("SEA OAuth authorization page failed");
  const ownerSecret = (
    await readFile(join(stateRoot, "secrets", "owner-passphrase"), "utf8")
  ).trim();
  const approval = await fetch(`${origin}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      transaction_id: transaction,
      owner_secret: ownerSecret,
      decision: "approve"
    })
  });
  if (approval.status !== 303) throw new Error("SEA OAuth approval failed");
  const code = new URL(approval.headers.get("location")).searchParams.get("code");
  const exchanged = await fetch(`${origin}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource
    })
  });
  if (!exchanged.ok) throw new Error("SEA OAuth token exchange failed");
  const access = (await exchanged.json()).access_token;
  let id = 0;
  async function call(name, args) {
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${access}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++id,
        method: "tools/call",
        params: { name, arguments: args }
      })
    });
    const text = await response.text();
    const payload = response.headers.get("content-type")?.includes("text/event-stream")
      ? text
          .split("\n")
          .find((line) => line.startsWith("data:"))
          ?.slice(5)
          .trim()
      : text;
    if (!response.ok || !payload) throw new Error("SEA MCP exchange failed");
    const reply = JSON.parse(payload);
    if (reply.error || !reply.result) throw new Error("SEA MCP tool dispatch failed");
    return reply.result;
  }
  const before = await call("core.read", { path: join(workRoot, "probe.txt") });
  if (
    before.structuredContent?.error?.code !== "context_required" ||
    before.structuredContent?.operationExecuted !== false
  )
    throw new Error("SEA bootstrap gate failed");
  const boot = await call("context.bootstrap", {});
  const slnctrzContext = boot.structuredContent?.contextToken;
  if (
    boot.isError ||
    !slnctrzContext ||
    boot.structuredContent?.catalog?.length !== 2 ||
    JSON.stringify(boot).includes("# Diagnose and verify a defect")
  )
    throw new Error("SEA catalog disclosure failed");
  const skill = await call("skills.read", { name: "debug-and-test", slnctrzContext });
  if (!skill.structuredContent?.content?.includes("# Diagnose and verify a defect"))
    throw new Error("SEA skill activation failed");
  const reference = await call("skills.read", {
    name: "debug-and-test",
    resource: "references/regression-checks.md",
    slnctrzContext
  });
  if (!reference.structuredContent?.content?.includes("# Choosing regression evidence"))
    throw new Error("SEA skill resource failed");
  const file = await call("core.read", { path: join(workRoot, "probe.txt"), slnctrzContext });
  if (file.structuredContent?.content !== "packaged-harness-read")
    throw new Error("SEA authorized file read failed");
  await call("context.close", { slnctrzContext });
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
});

try {
  const commandState = JSON.parse(await readFile(join(stateRoot, "command.json"), "utf8"));
  const entries = commandState?.shell?.allowlist?.added;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("SEA default command catalog smoke test produced no usable commands");
  }
} finally {
  await Promise.all(
    [stateRoot, workRoot].map((path) => rm(path, { recursive: true, force: true }))
  );
}

console.log(
  `SEA ${nativeTarget} gateway bootstrap + embedded assets + authenticated coding harness smoke test passed`
);
