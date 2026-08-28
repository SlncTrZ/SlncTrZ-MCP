/**
 * Linux x64 SEA Smoke Test — verify normal deny-all bootstrap without exposing credentials.
 * Wing: distribution | Topic: standalone-sea-smoke | Updated: 2026-08-28
 *
 * Provenance: PLAN Phase 8 and ADR-008.
 */

import { randomBytes, scryptSync } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binary = join(root, "dist", "standalone", "linux-x64", "slnctrz-mcp");
const salt = randomBytes(16);
const secret = randomBytes(32).toString("base64url");
const expected = scryptSync(secret, salt, 32, {
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024
});
const verifier = [
  "scrypt",
  "16384",
  "8",
  "1",
  salt.toString("base64url"),
  expected.toString("base64url")
].join("$");

const child = spawn(binary, [], {
  env: {
    SLNCTRZ_OWNER_SECRET_HASH: verifier,
    SLNCTRZ_PUBLIC_URL: "https://mcp.example.test/mcp",
    SLNCTRZ_PORT: "0",
    SLNCTRZ_CONTROL_PORT: "0"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let stdout = "";
let stderr = "";
let ready = false;
const timeout = setTimeout(() => {
  child.kill("SIGKILL");
}, 10_000);

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  if (
    stdout.includes("SlncTrZ-MCP listening on ") &&
    stdout.includes("SlncTrZ-MCP control plane listening on ")
  ) {
    ready = true;
    child.kill("SIGTERM");
  }
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

child.on("error", (error) => {
  clearTimeout(timeout);
  throw error;
});

child.on("exit", (code, signal) => {
  clearTimeout(timeout);
  if (!ready) {
    throw new Error(
      `SEA gateway smoke test failed before readiness (code=${String(code)}, signal=${String(signal)}): ${stderr}`
    );
  }
  console.log("SEA gateway bootstrap smoke test passed");
});
