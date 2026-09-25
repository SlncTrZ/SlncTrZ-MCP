/** Sign one exact release metadata file with the CI-only Ed25519 private key. */

import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const input = process.argv[2];
const output = process.argv[3];
if (input === undefined || output === undefined) {
  throw new Error("Usage: node scripts/sign-release-file.mjs <input> <signature-output>");
}

function requiredBase64(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value) {
    throw new Error(`${name} must be canonical base64`);
  }
  return { value, bytes };
}

const privateInput = requiredBase64("SLNCTRZ_RELEASE_SIGNING_PRIVATE_KEY_B64");
const publicInput = requiredBase64("SLNCTRZ_RELEASE_SIGNING_PUBLIC_KEY_B64");
const privateKey = createPrivateKey({
  key: privateInput.bytes,
  format: "der",
  type: "pkcs8"
});
if (privateKey.asymmetricKeyType !== "ed25519") {
  throw new Error("Release signing private key must be Ed25519");
}
const derivedPublic = createPublicKey(privateKey);
const derivedPublicDer = derivedPublic.export({ format: "der", type: "spki" });
if (!Buffer.isBuffer(derivedPublicDer)) throw new Error("Release signing public key export failed");
if (!derivedPublicDer.equals(publicInput.bytes)) {
  throw new Error("Release signing private/public key mismatch");
}
const keyId = `ed25519-sha256-${createHash("sha256")
  .update(publicInput.bytes)
  .digest("hex")
  .slice(0, 32)}`;
const bytes = await readFile(resolve(input));
const signature = sign(null, bytes, privateKey).toString("base64");
await writeFile(
  resolve(output),
  `${JSON.stringify({
    schemaVersion: 1,
    algorithm: "Ed25519",
    keyId,
    signature
  })}\n`,
  { encoding: "utf8", mode: 0o644 }
);
console.log(JSON.stringify({ status: "pass", keyId, file: resolve(input) }));
