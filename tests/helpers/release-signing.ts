import { generateKeyPairSync, sign } from "node:crypto";
import {
  createReleaseTrustKey,
  releaseSigningKeyId
} from "../../src/standalone/release-signature.js";

const pair = generateKeyPairSync("ed25519");
const publicKeySpkiBase64 = (
  pair.publicKey.export({ format: "der", type: "spki" }) as Buffer
).toString("base64");

export const TEST_RELEASE_TRUST_KEY = createReleaseTrustKey(publicKeySpkiBase64);
export const TEST_RELEASE_TRUST_KEYS = Object.freeze([TEST_RELEASE_TRUST_KEY]);

export function releaseSignatureDocument(manifest: string | Uint8Array): string {
  const bytes =
    typeof manifest === "string" ? Buffer.from(manifest, "utf8") : Buffer.from(manifest);
  const signature = sign(null, bytes, pair.privateKey).toString("base64");
  return JSON.stringify({
    schemaVersion: 1,
    algorithm: "Ed25519",
    keyId: releaseSigningKeyId(publicKeySpkiBase64),
    signature
  });
}

export function signedManifestResponse(
  input: Parameters<typeof fetch>[0],
  manifest: string | Uint8Array,
  artifact?: Uint8Array | Buffer
): Response {
  const url = String(input);
  if (url.endsWith(".sig")) {
    return new Response(releaseSignatureDocument(manifest), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
  if (url.includes("manifest")) {
    return new Response(manifest, {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
  return artifact === undefined
    ? new Response("missing", { status: 404 })
    : new Response(artifact, { status: 200 });
}
