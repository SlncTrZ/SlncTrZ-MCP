/** Publisher-authentic release manifest verification with an embedded Ed25519 trust root. */

import { createHash, createPublicKey, verify } from "node:crypto";

declare const __SLNCTRZ_RELEASE_SIGNING_PUBLIC_KEY_B64__: string;

export interface ReleaseTrustKey {
  readonly keyId: string;
  readonly publicKeySpkiBase64: string;
}

export interface ReleaseSignatureEnvelope {
  readonly schemaVersion: 1;
  readonly algorithm: "Ed25519";
  readonly keyId: string;
  readonly signature: string;
}

const KEY_ID = /^ed25519-sha256-[a-f0-9]{32}$/u;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label} contains unknown field ${key}`);
  }
}

function publicKeyBytes(value: string): Buffer {
  if (!BASE64.test(value)) throw new Error("Release signing public key is invalid");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value) {
    throw new Error("Release signing public key is not canonical base64");
  }
  const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Release signing public key must be Ed25519");
  }
  return bytes;
}

export function releaseSigningKeyId(publicKeySpkiBase64: string): string {
  return `ed25519-sha256-${createHash("sha256")
    .update(publicKeyBytes(publicKeySpkiBase64))
    .digest("hex")
    .slice(0, 32)}`;
}

export function createReleaseTrustKey(publicKeySpkiBase64: string): ReleaseTrustKey {
  return Object.freeze({
    keyId: releaseSigningKeyId(publicKeySpkiBase64),
    publicKeySpkiBase64
  });
}

export function embeddedReleaseTrustKeys(): readonly ReleaseTrustKey[] {
  const encoded =
    typeof __SLNCTRZ_RELEASE_SIGNING_PUBLIC_KEY_B64__ === "undefined"
      ? ""
      : __SLNCTRZ_RELEASE_SIGNING_PUBLIC_KEY_B64__;
  if (encoded.length === 0) throw new Error("release_signature_trust_root_unconfigured");
  return Object.freeze([createReleaseTrustKey(encoded)]);
}

export function parseReleaseSignatureEnvelope(value: unknown): ReleaseSignatureEnvelope {
  const raw = record(value, "Release manifest signature");
  exactKeys(
    raw,
    ["schemaVersion", "algorithm", "keyId", "signature"],
    "Release manifest signature"
  );
  if (raw.schemaVersion !== 1) {
    throw new Error("Release manifest signature schemaVersion must be 1");
  }
  if (raw.algorithm !== "Ed25519") {
    throw new Error("Release manifest signature algorithm must be Ed25519");
  }
  if (typeof raw.keyId !== "string" || !KEY_ID.test(raw.keyId)) {
    throw new Error("Release manifest signature keyId is invalid");
  }
  if (typeof raw.signature !== "string" || !BASE64.test(raw.signature)) {
    throw new Error("Release manifest signature is invalid");
  }
  const signatureBytes = Buffer.from(raw.signature, "base64");
  if (signatureBytes.length !== 64 || signatureBytes.toString("base64") !== raw.signature) {
    throw new Error("Release manifest signature must be canonical Ed25519 base64");
  }
  return Object.freeze({
    schemaVersion: 1,
    algorithm: "Ed25519",
    keyId: raw.keyId,
    signature: raw.signature
  });
}

export function verifyReleaseManifestSignature(
  manifestBytes: Uint8Array,
  envelope: ReleaseSignatureEnvelope,
  trustedKeys: readonly ReleaseTrustKey[]
): void {
  if (trustedKeys.length === 0) throw new Error("release_signature_trust_root_unconfigured");
  const trusted = trustedKeys.find((candidate) => candidate.keyId === envelope.keyId);
  if (trusted === undefined) throw new Error("Release manifest signature key is not trusted");
  const keyBytes = publicKeyBytes(trusted.publicKeySpkiBase64);
  if (releaseSigningKeyId(trusted.publicKeySpkiBase64) !== trusted.keyId) {
    throw new Error("Release signing trust key ID does not match its public key");
  }
  const publicKey = createPublicKey({ key: keyBytes, format: "der", type: "spki" });
  const signature = Buffer.from(envelope.signature, "base64");
  if (!verify(null, Buffer.from(manifestBytes), publicKey, signature)) {
    throw new Error("Release manifest signature verification failed");
  }
}
