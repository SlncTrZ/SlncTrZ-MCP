import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrap } from "../../src/app/main.js";

const cleanup: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function transactionFromHtml(html: string): string {
  const match = html.match(/name="transaction_id" value="([^"]+)"/u);
  if (match?.[1] === undefined) throw new Error("Missing authorization transaction");
  return match[1];
}

async function waitForHealth(origin: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) return;
    } catch {
      // Gateway is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("gateway did not become healthy");
}

async function authorize(origin: string, ownerSecret: string): Promise<string> {
  const resource = `${origin}/mcp`;
  const redirectUri = "https://shutdown-client.example.com/callback";
  const registration = await fetch(`${origin}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Shutdown E2E",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    })
  });
  expect(registration.status).toBe(201);
  const client = (await registration.json()) as { client_id: string };
  const verifier = "v".repeat(43);
  const authorizeUrl = new URL("/authorize", origin);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
    resource,
    scope: "mcp:tools"
  }).toString();
  const page = await fetch(authorizeUrl);
  const transactionId = transactionFromHtml(await page.text());
  const approval = await fetch(`${origin}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      transaction_id: transactionId,
      owner_secret: ownerSecret,
      decision: "approve"
    }),
    redirect: "manual"
  });
  expect(approval.status).toBe(303);
  const callback = new URL(approval.headers.get("location") ?? "");
  const token = await fetch(`${origin}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: callback.searchParams.get("code") ?? "",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource
    })
  });
  expect(token.status).toBe(200);
  return ((await token.json()) as { access_token: string }).access_token;
}

interface McpPayload {
  readonly result?: {
    readonly isError?: boolean;
    readonly structuredContent?: Record<string, unknown>;
  };
}

async function readMcpPayload(response: Response): Promise<McpPayload> {
  const body = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = body
      .split("\n")
      .find((line) => line.startsWith("data:"))
      ?.slice("data:".length)
      .trim();
    if (data === undefined) throw new Error("MCP SSE response has no data frame");
    return JSON.parse(data) as McpPayload;
  }
  return JSON.parse(body) as McpPayload;
}

async function taskStart(origin: string, token: string, args: readonly string[]): Promise<string> {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "task.start",
        arguments: { command: "node", args, timeoutMs: 60_000 }
      }
    })
  });
  const payload = await readMcpPayload(response);
  expect(payload.result?.isError).not.toBe(true);
  const taskId = String(payload.result?.structuredContent?.taskId ?? "");
  expect(taskId).not.toBe("");
  return taskId;
}

async function waitForPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const pid = Number.parseInt(await readFile(path, "utf8"), 10);
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch {
      // Managed task has not written it yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("managed descendant PID was not written");
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gateway did not exit after signal")), 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function expectProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`managed descendant ${pid} survived gateway shutdown`);
}

describe.skipIf(process.platform !== "win32")(
  "application lifecycle graceful shutdown on Windows",
  () => {
    it("cancels managed descendant process trees through ApplicationLifecycle.shutdown", async () => {
      const stateRoot = await mkdtemp(join(process.cwd(), ".shutdown-state-win-"));
      const workspace = await mkdtemp(join(process.cwd(), ".shutdown-workspace-win-"));
      cleanup.push(stateRoot, workspace);
      const ownerSecret = "shutdown-owner-secret-windows-123456";
      await mkdir(join(stateRoot, "secrets"), { recursive: true });
      await writeFile(join(stateRoot, "secrets", "owner-passphrase"), `${ownerSecret}\n`, "utf8");
      await writeFile(
        join(stateRoot, "policy.json"),
        JSON.stringify({ schemaVersion: 2, paths: [workspace], authorityMode: "restricted" }),
        "utf8"
      );
      await writeFile(
        join(stateRoot, "command.json"),
        JSON.stringify({ shell: { allowlist: { added: ["node"] } } }),
        "utf8"
      );

      const port = await freePort();
      const controlPort = await freePort();
      const origin = `http://127.0.0.1:${port}`;
      const lifecycle = await bootstrap({
        config: {
          host: "127.0.0.1",
          port,
          publicMcpUrl: new URL(`${origin}/mcp`),
          maxDynamicClients: 16,
          controlHost: "127.0.0.1",
          controlPort,
          telemetryEnabled: false,
          ownerWebEnabled: false,
          allowedHostnames: ["127.0.0.1"],
          allowedOriginHostnames: ["127.0.0.1"],
          stateRoot
        }
      });

      try {
        await waitForHealth(origin);
        const token = await authorize(origin, ownerSecret);
        const pidFile = join(workspace, "descendant.pid");
        const childScript = "setInterval(() => {}, 1000)";
        const parent = [
          "const { spawn } = require('node:child_process');",
          "const { writeFileSync } = require('node:fs');",
          `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
          `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
          "setInterval(() => {}, 1000);"
        ].join("\n");
        await taskStart(origin, token, ["-e", parent]);
        const descendantPid = await waitForPid(pidFile);

        await lifecycle.shutdown();
        await expect(expectProcessGone(descendantPid)).resolves.toBeUndefined();
        await expect(fetch(`${origin}/healthz`)).rejects.toThrow();
        await expect(lifecycle.shutdown()).resolves.toBeUndefined();
      } finally {
        await lifecycle.shutdown();
      }
    }, 15_000);
  }
);

describe.skipIf(process.platform === "win32")("application entry graceful shutdown", () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    it(`cancels managed descendants through the real entry on ${signal}`, async () => {
      const bundleRoot = await mkdtemp(join(process.cwd(), ".shutdown-entry-"));
      const stateRoot = await mkdtemp(join(process.cwd(), ".shutdown-state-"));
      const workspace = await mkdtemp(join(process.cwd(), ".shutdown-workspace-"));
      cleanup.push(bundleRoot, stateRoot, workspace);
      const ownerSecret = "shutdown-owner-secret-123456";
      await mkdir(join(stateRoot, "secrets"), { recursive: true });
      const ownerFile = join(stateRoot, "secrets", "owner-passphrase");
      await writeFile(ownerFile, `${ownerSecret}\n`, { mode: 0o600 });
      await chmod(ownerFile, 0o600);
      await writeFile(
        join(stateRoot, "policy.json"),
        JSON.stringify({ schemaVersion: 2, paths: [workspace], authorityMode: "restricted" }),
        "utf8"
      );
      await writeFile(
        join(stateRoot, "command.json"),
        JSON.stringify({ shell: { allowlist: { added: ["node"] } } }),
        "utf8"
      );

      const outfile = join(bundleRoot, "app", "entry.mjs");
      await mkdir(join(bundleRoot, "app"), { recursive: true });
      await build({
        absWorkingDir: process.cwd(),
        entryPoints: ["src/app/entry.ts"],
        outfile,
        bundle: true,
        platform: "node",
        format: "esm",
        packages: "external",
        sourcemap: false
      });

      const port = await freePort();
      const controlPort = await freePort();
      const origin = `http://127.0.0.1:${port}`;
      const gateway = spawn(process.execPath, [outfile], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SLNCTRZ_HOST: "127.0.0.1",
          SLNCTRZ_PORT: String(port),
          SLNCTRZ_CONTROL_HOST: "127.0.0.1",
          SLNCTRZ_CONTROL_PORT: String(controlPort),
          SLNCTRZ_STATE_ROOT: stateRoot,
          SLNCTRZ_TELEMETRY_ENABLED: "false",
          SLNCTRZ_OWNER_WEB_ENABLED: "false"
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      children.push(gateway);
      let stderr = "";
      gateway.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      await waitForHealth(origin);
      const token = await authorize(origin, ownerSecret);

      const pidFile = join(workspace, "descendant.pid");
      const stubborn = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
      const parent = [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(stubborn)}], { stdio: 'ignore' });`,
        `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        "setInterval(() => {}, 1000);"
      ].join("\n");
      await taskStart(origin, token, ["-e", parent]);
      const descendantPid = await waitForPid(pidFile);

      gateway.kill(signal);
      await expect(waitForExit(gateway)).resolves.toBeUndefined();
      expect(gateway.exitCode, stderr).not.toBeNull();
      await expect(expectProcessGone(descendantPid)).resolves.toBeUndefined();
    });
  }
});
