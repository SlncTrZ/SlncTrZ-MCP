import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOwnerSecret } from "../../src/auth/owner-secret-store.js";
import { createOwnerSecretHash, verifyOwnerSecret } from "../../src/auth/owner-verifier.js";

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{ root: string; secretFile: string }> {
  const root = await mkdtemp(join(tmpdir(), "slnctrz-owner-secret-"));
  temporaryDirectories.push(root);
  const secrets = join(root, "secrets");
  await mkdir(secrets, { mode: 0o700 });
  return { root, secretFile: join(secrets, "owner-passphrase") };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("owner secret store", () => {
  it("uses the managed plaintext file as source of truth over a legacy environment verifier", async () => {
    const { secretFile } = await fixture();
    const fileSecret = "managed owner passphrase 123";
    await writeFile(secretFile, `${fileSecret}\n`, { mode: 0o600 });
    const legacyHash = createOwnerSecretHash("legacy environment passphrase");

    const resolved = await resolveOwnerSecret({ secretFile, environmentHash: legacyHash });

    expect(resolved.source).toBe("file");
    expect(resolved.recoveryFile).toBe(secretFile);
    expect(verifyOwnerSecret(fileSecret, resolved.ownerSecretHash)).toBe(true);
    expect(verifyOwnerSecret("legacy environment passphrase", resolved.ownerSecretHash)).toBe(
      false
    );
  });

  it("migrates an env-hash-only state to a recoverable plaintext file (degraded -> migrated)", async () => {
    const { secretFile } = await fixture();
    const legacyHash = createOwnerSecretHash("legacy environment passphrase");

    const resolved = await resolveOwnerSecret({ secretFile, environmentHash: legacyHash });

    // No plaintext recovery file => degraded/migration state, surfaced (not silently normal).
    expect(resolved.source).toBe("migrated");
    expect(resolved.recoveryFile).toBe(secretFile);
    expect(resolved.migratedFrom).toBe("environment-hash");
    const persisted = (await readFile(secretFile, "utf8")).replace(/\r?\n$/u, "");
    expect(persisted).toHaveLength(32);
    // Login now verifies against the fresh recovered plaintext, never the legacy hash.
    expect(verifyOwnerSecret(persisted, resolved.ownerSecretHash)).toBe(true);
    expect(verifyOwnerSecret("legacy environment passphrase", resolved.ownerSecretHash)).toBe(
      false
    );
  });

  it("creates a private recovery file on clean install that survives restart", async () => {
    const { root, secretFile } = await fixture();

    const first = await resolveOwnerSecret({ secretFile });
    expect(first.source).toBe("generated");
    const persisted = (await readFile(secretFile, "utf8")).replace(/\r?\n$/u, "");
    expect(persisted).toHaveLength(32);
    expect(verifyOwnerSecret(persisted, first.ownerSecretHash)).toBe(true);
    if (process.platform !== "win32") {
      const { stat } = await import("node:fs/promises");
      expect((await stat(secretFile)).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, "secrets"))).mode & 0o777).toBe(0o700);
    }

    // Restart/resolve again keeps the same file and passphrase (recovery survives restarts).
    const second = await resolveOwnerSecret({ secretFile });
    expect(second.source).toBe("file");
    expect(await readFile(secretFile, "utf8")).toBe(`${persisted}\n`);
    expect(verifyOwnerSecret(persisted, second.ownerSecretHash)).toBe(true);
  });

  it("never surfaces the plaintext passphrase in the resolved material", async () => {
    const { secretFile } = await fixture();
    const resolved = await resolveOwnerSecret({ secretFile });
    const persisted = (await readFile(secretFile, "utf8")).replace(/\r?\n$/u, "");

    expect(Object.keys(resolved).sort()).toEqual(["ownerSecretHash", "recoveryFile", "source"]);
    expect(JSON.stringify(resolved)).not.toContain(persisted);
  });

  it("generates and persists a recoverable passphrase for a fresh install", async () => {
    const { secretFile } = await fixture();

    const resolved = await resolveOwnerSecret({ secretFile });
    const persisted = (await readFile(secretFile, "utf8")).replace(/\r?\n$/u, "");

    expect(resolved.source).toBe("generated");
    expect(persisted).toHaveLength(32);
    expect(verifyOwnerSecret(persisted, resolved.ownerSecretHash)).toBe(true);
    if (process.platform !== "win32") {
      const { stat } = await import("node:fs/promises");
      expect((await stat(secretFile)).mode & 0o777).toBe(0o600);
    }
  });

  it.skipIf(process.platform === "win32")(
    "fails closed when the plaintext file is group/world accessible",
    async () => {
      const { secretFile } = await fixture();
      await writeFile(secretFile, "managed owner passphrase 123\n", { mode: 0o600 });
      await chmod(secretFile, 0o644);

      await expect(resolveOwnerSecret({ secretFile })).rejects.toThrow("mode 0600");
    }
  );

  it("picks up a directly edited passphrase on the next startup resolution", async () => {
    const { secretFile } = await fixture();
    await writeFile(secretFile, "first managed passphrase 123\n", { mode: 0o600 });
    const first = await resolveOwnerSecret({ secretFile });

    await writeFile(secretFile, "second managed passphrase 456\n", { mode: 0o600 });
    const second = await resolveOwnerSecret({ secretFile });

    expect(verifyOwnerSecret("first managed passphrase 123", first.ownerSecretHash)).toBe(true);
    expect(verifyOwnerSecret("second managed passphrase 456", second.ownerSecretHash)).toBe(true);
    expect(verifyOwnerSecret("first managed passphrase 123", second.ownerSecretHash)).toBe(false);
  });
});
