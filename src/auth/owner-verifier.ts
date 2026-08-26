/**
 * Owner Verifier — derives and verifies memory-hard owner passphrase hashes.
 * Wing: auth | Topic: owner-authentication | Updated: 2026-08-26
 *
 * Provenance: SECURITY invariant 1 and Node.js public crypto APIs.
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const FORMAT = "scrypt";
const KEY_LENGTH = 32;
const COST = 16_384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const MAX_MEMORY = 64 * 1024 * 1024;
const MIN_SECRET_LENGTH = 16;
const MAX_SECRET_LENGTH = 1_024;

interface ParsedVerifier {
  readonly cost: number;
  readonly blockSize: number;
  readonly parallelization: number;
  readonly salt: Buffer;
  readonly expected: Buffer;
}

function validateSecret(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH || secret.length > MAX_SECRET_LENGTH) {
    throw new Error(
      `Owner secret must contain ${MIN_SECRET_LENGTH}-${MAX_SECRET_LENGTH} characters`
    );
  }
}

function parseVerifier(encodedHash: string): ParsedVerifier {
  const parts = encodedHash.split("$");
  if (parts.length !== 6 || parts[0] !== FORMAT) {
    throw new Error("SLNCTRZ_OWNER_SECRET_HASH has an invalid format");
  }

  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelization = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? "", "base64url");
  const expected = Buffer.from(parts[5] ?? "", "base64url");

  if (
    cost !== COST ||
    blockSize !== BLOCK_SIZE ||
    parallelization !== PARALLELIZATION ||
    salt.byteLength !== 16 ||
    expected.byteLength !== KEY_LENGTH
  ) {
    throw new Error("SLNCTRZ_OWNER_SECRET_HASH uses unsupported parameters");
  }

  return { cost, blockSize, parallelization, salt, expected };
}

/** Create a portable scrypt verifier. The raw secret is never retained. */
export function createOwnerSecretHash(secret: string): string {
  validateSecret(secret);
  const salt = randomBytes(16);
  const derived = scryptSync(secret, salt, KEY_LENGTH, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELIZATION,
    maxmem: MAX_MEMORY
  });

  return [
    FORMAT,
    COST,
    BLOCK_SIZE,
    PARALLELIZATION,
    salt.toString("base64url"),
    derived.toString("base64url")
  ].join("$");
}

/** Validate the runtime verifier without accepting or retaining the raw secret. */
export function validateOwnerSecretHash(encodedHash: string): void {
  parseVerifier(encodedHash);
}

/** Verify an owner passphrase against a strict scrypt verifier string. */
export function verifyOwnerSecret(secret: string, encodedHash: string): boolean {
  if (secret.length > MAX_SECRET_LENGTH) return false;

  const { cost, blockSize, parallelization, salt, expected } = parseVerifier(encodedHash);
  const actual = scryptSync(secret, salt, KEY_LENGTH, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: MAX_MEMORY
  });
  return timingSafeEqual(actual, expected);
}
