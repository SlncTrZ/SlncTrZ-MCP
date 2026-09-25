import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createReleaseTrustKey,
  parseReleaseSignatureEnvelope,
  releaseSigningKeyId,
  verifyReleaseManifestSignature
} from "../../src/standalone/release-signature.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function keyPair() {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  return {
    pair,
    publicKeyB64: publicKey.toString("base64"),
    privateKeyB64: privateKey.toString("base64")
  };
}

describe("release publisher signature", () => {
  it("binds the signature to exact manifest bytes and the trusted key id", () => {
    const signing = keyPair();
    const bytes = Buffer.from('{"schemaVersion":1,"version":"1.2.3"}\n', "utf8");
    const trustKey = createReleaseTrustKey(signing.publicKeyB64);
    const envelope = parseReleaseSignatureEnvelope({
      schemaVersion: 1,
      algorithm: "Ed25519",
      keyId: releaseSigningKeyId(signing.publicKeyB64),
      signature: sign(null, bytes, signing.pair.privateKey).toString("base64")
    });

    expect(() => verifyReleaseManifestSignature(bytes, envelope, [trustKey])).not.toThrow();
    expect(() =>
      verifyReleaseManifestSignature(
        Buffer.from(bytes.toString("utf8").replace("1.2.3", "1.2.4"), "utf8"),
        envelope,
        [trustKey]
      )
    ).toThrow("verification failed");

    const other = keyPair();
    expect(() =>
      verifyReleaseManifestSignature(bytes, envelope, [createReleaseTrustKey(other.publicKeyB64)])
    ).toThrow("not trusted");
  });

  it("signs one exact file with the CI key pair and rejects a mismatched public key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "slnctrz-release-signing-"));
    cleanup.push(directory);
    const manifest = join(directory, "manifest.json");
    const signaturePath = join(directory, "manifest.json.sig");
    const bytes = Buffer.from('{"schemaVersion":1,"version":"9.9.9"}\n', "utf8");
    await writeFile(manifest, bytes);

    const signing = keyPair();
    const script = fileURLToPath(new URL("../../scripts/sign-release-file.mjs", import.meta.url));
    execFileSync(process.execPath, [script, manifest, signaturePath], {
      env: {
        ...process.env,
        SLNCTRZ_RELEASE_SIGNING_PRIVATE_KEY_B64: signing.privateKeyB64,
        SLNCTRZ_RELEASE_SIGNING_PUBLIC_KEY_B64: signing.publicKeyB64
      },
      stdio: "pipe"
    });

    const envelope = parseReleaseSignatureEnvelope(
      JSON.parse(await readFile(signaturePath, "utf8")) as unknown
    );
    expect(() =>
      verifyReleaseManifestSignature(bytes, envelope, [createReleaseTrustKey(signing.publicKeyB64)])
    ).not.toThrow();

    const mismatch = keyPair();
    expect(() =>
      execFileSync(process.execPath, [script, manifest, join(directory, "bad.sig")], {
        env: {
          ...process.env,
          SLNCTRZ_RELEASE_SIGNING_PRIVATE_KEY_B64: signing.privateKeyB64,
          SLNCTRZ_RELEASE_SIGNING_PUBLIC_KEY_B64: mismatch.publicKeyB64
        },
        stdio: "pipe"
      })
    ).toThrow();
  });
});
