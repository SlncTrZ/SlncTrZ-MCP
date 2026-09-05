/**
 * LEGACY Owner Verifier Generator — compatibility utility for pre-recovery-file deployments.
 * Wing: scripts | Topic: owner-secret-bootstrap | Updated: 2026-08-26
 *
 * Legacy security contract only:
 *   - This script writes only a derived verifier to `_runtime/owner.env` (0600).
 *   - It is NOT the current normal owner-credential workflow. Current runtime uses the managed
 *     recovery passphrase at `<stateRoot>/secrets/owner-passphrase` as its source of truth.
 *   - KDF parameters come from src/auth/owner-verifier.ts (single source of truth).
 *
 * Provenance: SECURITY invariant 1, ADR-011, and Node public cryptography APIs.
 *
 * Usage:
 *   node scripts/generate-owner-verifier.mjs          # interactive muted prompt
 *   node scripts/generate-owner-verifier.mjs --random # CSPRNG secret, print once
 */

import { randomBytes } from "node:crypto";
import { closeSync, chmodSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOwnerSecretHash, validateOwnerSecretHash } from "../dist/auth/owner-verifier.js";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNTIME_DIR = join(PROJECT_ROOT, "_runtime");
const OWNER_ENV_FILE = join(RUNTIME_DIR, "owner.env");
const RANDOM_SECRET_LENGTH = 32;

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  if (args.has("--help") || args.has("-h")) {
    return { help: true, random: false };
  }
  return { help: false, random: args.has("--random") };
}

function generateRandomSecret(length) {
  return randomBytes(Math.ceil((length * 3) / 4))
    .toString("base64url")
    .slice(0, length);
}

function writeVerifier(secret) {
  const hash = createOwnerSecretHash(secret);
  validateOwnerSecretHash(hash);
  mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  const fd = openSync(OWNER_ENV_FILE, "w", 0o600);
  writeFileSync(fd, `SLNCTRZ_OWNER_SECRET_HASH=${hash}\n`);
  closeSync(fd);
  chmodSync(OWNER_ENV_FILE, 0o600);
  return hash;
}

/**
 * Muted terminal prompt: reads a line with echo suppressed. Returns null on Ctrl-C.
 * Only callable when stdin is a TTY; the automated path must use --random instead.
 */
function promptSecret(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        "refusing interactive prompt on non-TTY; use `--random` or pipe stdin safely instead.\n"
      );
      process.exit(2);
    }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write(question);
    let input = "";
    const onData = (chunk) => {
      const char = chunk.toString("utf8");
      if (char === "\r" || char === "\n") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(input);
      } else if (char === "\u0003") {
        process.stdin.setRawMode(false);
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        process.stdout.write("^C\n");
        resolve(null);
      } else if (char === "\u007f" || char === "\b") {
        input = input.slice(0, -1);
        process.stdout.write("\b \b");
      } else if (char >= " ") {
        input += char;
        process.stdout.write("*");
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main() {
  const { help, random } = parseArgs(process.argv);
  process.stderr.write(
    "LEGACY: generate-owner-verifier.mjs is not the normal owner-passphrase setup path; " +
      "use managed <stateRoot>/secrets/owner-passphrase for current deployments.\n"
  );
  if (help) {
    process.stdout.write(
      [
        "Legacy Owner Verifier Generator",
        "  (interactive) node scripts/generate-owner-verifier.mjs",
        "  (random)     node scripts/generate-owner-verifier.mjs --random",
        "",
        `Writes legacy SLNCTRZ_OWNER_SECRET_HASH to ${OWNER_ENV_FILE} (0600, gitignored).`,
        "Current deployments use the managed Owner Passphrase recovery file instead."
      ].join("\n") + "\n"
    );
    return;
  }

  let secret;
  if (random) {
    secret = generateRandomSecret(RANDOM_SECRET_LENGTH);
    writeVerifier(secret);
    process.stdout.write(`\nGenerated a ${RANDOM_SECRET_LENGTH}-char owner secret.\n`);
    process.stdout.write("SAVE THIS ONCE — it is only shown here and never stored:\n\n");
    process.stdout.write(`  ${secret}\n\n`);
    process.stdout.write(
      "Store it in a password manager / offline secret store. It is NOT in git, logs, or KB.\n"
    );
    return;
  }

  const entered = await promptSecret("Owner secret (≥16 chars, input hidden): ");
  if (entered === null) {
    process.stderr.write("Aborted.\n");
    process.exit(1);
  }
  writeVerifier(entered);
  process.stdout.write(`Wrote verifier to ${OWNER_ENV_FILE} (0600).\n`);
}

await main();
