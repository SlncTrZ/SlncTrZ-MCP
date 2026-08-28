/**
 * Reproducible local performance baseline for the developer runtime.
 * Records cold CLI start, gateway readiness latency, and Linux RSS without external network.
 */

import { randomBytes, scryptSync } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { cpus, release as operatingSystemRelease } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGatewayServer, listenGateway } from "../dist/app/http-server.js";
import { OAuthService } from "../dist/auth/oauth-service.js";
import { createOwnerSecretHash } from "../dist/auth/owner-verifier.js";
import { createKernelPolicySnapshot } from "../dist/policy/kernel-policy.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "dist", "app", "entry.js");
const DEFAULT_ITERATIONS = 5;
const DEFAULT_WARMUP = 1;
const STARTUP_TIMEOUT_MS = 10_000;

function parseArguments(args) {
  let iterations = DEFAULT_ITERATIONS;
  let warmup = DEFAULT_WARMUP;
  let output;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--iterations" && value !== undefined) {
      iterations = Number(value);
      index += 1;
      continue;
    }
    if (argument === "--warmup" && value !== undefined) {
      warmup = Number(value);
      index += 1;
      continue;
    }
    if (argument === "--out" && value !== undefined) {
      output = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete benchmark argument: ${argument ?? ""}`);
  }
  for (const [name, value] of Object.entries({ iterations, warmup })) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 30 || (name === "iterations" && value === 0)) {
      throw new Error(`${name} must be an integer from ${name === "iterations" ? "1" : "0"} to 30`);
    }
  }
  return { iterations, warmup, output };
}

function verifier() {
  const salt = randomBytes(16);
  const secret = randomBytes(32).toString("base64url");
  const derived = scryptSync(secret, salt, 32, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  });
  return ["scrypt", "16384", "8", "1", salt.toString("base64url"), derived.toString("base64url")].join("$");
}

function cleanEnvironment() {
  return {
    PATH: process.env.PATH ?? "",
    SLNCTRZ_OWNER_SECRET_HASH: verifier(),
    SLNCTRZ_PUBLIC_URL: "https://mcp.benchmark.invalid/mcp",
    SLNCTRZ_HOST: "127.0.0.1",
    SLNCTRZ_PORT: "0",
    SLNCTRZ_CONTROL_HOST: "127.0.0.1",
    SLNCTRZ_CONTROL_PORT: "0",
    SLNCTRZ_TELEMETRY_ENABLED: "false",
    SLNCTRZ_MAX_DYNAMIC_CLIENTS: "1"
  };
}

function percentile(samples, percentileValue) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil((percentileValue / 100) * sorted.length) - 1];
}

function summarize(samples) {
  return {
    count: samples.length,
    minMs: Math.min(...samples),
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    p99Ms: percentile(samples, 99),
    maxMs: Math.max(...samples)
  };
}

async function readRssBytes(pid) {
  if (process.platform !== "linux") return undefined;
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  const kibibytes = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status)?.[1];
  return kibibytes === undefined ? undefined : Number(kibibytes) * 1024;
}

function spawnCli() {
  return new Promise((resolvePromise, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, [entry, "--help"], {
      cwd: root,
      env: cleanEnvironment(),
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0 || signal !== null) {
        reject(new Error(`CLI benchmark failed (code=${String(code)}, signal=${String(signal)}): ${stderr.trim()}`));
        return;
      }
      resolvePromise(performance.now() - started);
    });
  });
}

function spawnGateway() {
  return new Promise((resolvePromise, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      env: cleanEnvironment(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let ready = false;
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, STARTUP_TIMEOUT_MS);
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (
        !ready &&
        stdout.includes("SlncTrZ-MCP listening on ") &&
        stdout.includes("SlncTrZ-MCP control plane listening on ")
      ) {
        ready = true;
        void readRssBytes(child.pid).then(
          (rssBytes) => {
            const elapsedMs = performance.now() - started;
            child.kill("SIGTERM");
            child.once("exit", () => settle(() => resolvePromise({ elapsedMs, rssBytes })));
          },
          (error) => settle(() => reject(error))
        );
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => settle(() => reject(error)));
    child.once("exit", (code, signal) => {
      if (!ready) {
        settle(() =>
          reject(
            new Error(
              `Gateway benchmark failed before readiness (code=${String(code)}, signal=${String(signal)}): ${stderr.trim()}`
            )
          )
        );
      }
    });
  });
}

async function runSamples(warmup, iterations, operation) {
  for (let index = 0; index < warmup; index += 1) await operation();
  const samples = [];
  for (let index = 0; index < iterations; index += 1) samples.push(await operation());
  return samples;
}

async function startRequestFixture() {
  const ownerSecret = "benchmark owner secret";
  const resource = "https://mcp.benchmark.invalid/mcp";
  const oauthService = new OAuthService({
    issuer: new URL("https://mcp.benchmark.invalid"),
    resource: new URL(resource),
    ownerSecretHash: createOwnerSecretHash(ownerSecret)
  });
  const client = oauthService.registerClient({
    redirect_uris: ["https://client.benchmark.invalid/callback"],
    token_endpoint_auth_method: "none"
  });
  const verifierValue = "b".repeat(43);
  const pending = oauthService.beginAuthorization({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "https://client.benchmark.invalid/callback",
    code_challenge: oauthService.pkceChallenge(verifierValue),
    code_challenge_method: "S256",
    resource,
    scope: "mcp:tools"
  });
  const redirect = oauthService.approveAuthorization(pending.transactionId, ownerSecret);
  const tokens = oauthService.exchangeAuthorizationCode({
    grant_type: "authorization_code",
    code: redirect.searchParams.get("code") ?? "",
    client_id: client.client_id,
    redirect_uri: "https://client.benchmark.invalid/callback",
    code_verifier: verifierValue,
    resource
  });
  const server = createGatewayServer({
    oauthService,
    kernelPolicy: createKernelPolicySnapshot({ workspaceId: "benchmark" })
  });
  const address = await listenGateway(server, { host: "127.0.0.1", port: 0 });
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    accessToken: tokens.access_token
  };
}

async function closeServer(server) {
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
  });
}

async function timedRequest(url, init) {
  const started = performance.now();
  const response = await fetch(url, init);
  await response.arrayBuffer();
  if (!response.ok) throw new Error(`Request benchmark failed with HTTP ${response.status}`);
  return performance.now() - started;
}

async function runRequestBenchmark(iterations) {
  const fixture = await startRequestFixture();
  let requestId = 1;
  const measuredIterations = Math.max(100, iterations * 20);
  const authenticatedHeaders = {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${fixture.accessToken}`,
    "content-type": "application/json",
    "mcp-protocol-version": "2025-06-18"
  };
  const health = () => timedRequest(`${fixture.origin}/healthz`);
  const ping = () =>
    timedRequest(`${fixture.origin}/mcp`, {
      method: "POST",
      headers: authenticatedHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId++, method: "ping", params: {} })
    });

  try {
    const rssIdleBytes = process.memoryUsage.rss();
    const healthSamples = await runSamples(10, measuredIterations, health);
    const pingSamples = await runSamples(10, measuredIterations, ping);
    const rssOneClientBytes = process.memoryUsage.rss();

    const concurrentSamples = [];
    const concurrency = 8;
    const concurrentRequests = 64;
    let next = 0;
    const started = performance.now();
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < concurrentRequests) {
          next += 1;
          concurrentSamples.push(await ping());
        }
      })
    );
    const elapsedMs = performance.now() - started;
    const rssConcurrentBytes = process.memoryUsage.rss();

    return {
      sampleCount: measuredIterations,
      health: { samplesMs: healthSamples, summary: summarize(healthSamples) },
      authenticatedCorePing: { samplesMs: pingSamples, summary: summarize(pingSamples) },
      estimatedGatewayOverhead: {
        p50Ms: summarize(pingSamples).p50Ms - summarize(healthSamples).p50Ms,
        p95Ms: summarize(pingSamples).p95Ms - summarize(healthSamples).p95Ms,
        p99Ms: summarize(pingSamples).p99Ms - summarize(healthSamples).p99Ms
      },
      concurrency: {
        width: concurrency,
        requests: concurrentRequests,
        elapsedMs,
        requestsPerSecond: (concurrentRequests * 1000) / elapsedMs,
        latency: summarize(concurrentSamples)
      },
      memory: {
        rssIdleBytes,
        rssOneClientBytes,
        rssConcurrentBytes
      }
    };
  } finally {
    await closeServer(fixture.server);
  }
}

const options = parseArguments(process.argv.slice(2));
const cliSamples = await runSamples(options.warmup, options.iterations, spawnCli);
const gatewaySamples = await runSamples(options.warmup, options.iterations, spawnGateway);
const requestBaseline = await runRequestBenchmark(options.iterations);
const result = {
  schemaVersion: 2,
  measuredAt: new Date().toISOString(),
  environment: {
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    iterations: options.iterations,
    warmup: options.warmup,
    protocolVersion: "2025-06-18",
    commitSha: process.env.GITHUB_SHA ?? "unknown",
    operatingSystemRelease: operatingSystemRelease(),
    cpuModel: cpus()[0]?.model ?? "unknown",
    logicalCpuCount: cpus().length
  },
  cliHelpColdStart: {
    samplesMs: cliSamples,
    summary: summarize(cliSamples)
  },
  gatewayReadiness: {
    samplesMs: gatewaySamples.map((sample) => sample.elapsedMs),
    summary: summarize(gatewaySamples.map((sample) => sample.elapsedMs)),
    rssBytes: gatewaySamples.map((sample) => sample.rssBytes).filter((value) => value !== undefined),
    peakRssBytes: Math.max(...gatewaySamples.map((sample) => sample.rssBytes ?? 0))
  },
  requestBaseline
};
const serialized = `${JSON.stringify(result, null, 2)}\n`;
JSON.parse(serialized);
if (options.output !== undefined) {
  await writeFile(options.output, serialized, "utf8");
  process.stdout.write(
    `${JSON.stringify({
      output: options.output,
      cliHelpColdStart: result.cliHelpColdStart.summary,
      gatewayReadiness: result.gatewayReadiness.summary,
      authenticatedCorePing: result.requestBaseline.authenticatedCorePing.summary,
      concurrentCorePing: result.requestBaseline.concurrency.latency,
      memory: result.requestBaseline.memory
    })}\n`
  );
} else {
  process.stdout.write(serialized);
}
