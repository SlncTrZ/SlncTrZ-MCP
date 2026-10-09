/**
 * MCP Credential Store — owner-managed provider secrets behind opaque references.
 * Raw values are only returned to the extension runtime resolver and never serialized to policy.
 */

import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import * as z from "zod/v4";
import type { ProviderCredential } from "../extension/adapter.js";
import { ensureWindowsPrivateAcl } from "../shared/windows-private-acl.js";

const REF_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;

const systemdCredentialSchema = z
  .object({
    kind: z.literal("systemd-bearer"),
    unit: z.string().regex(/^[A-Za-z0-9_@.-]{1,200}\.service$/u),
    credential: z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,79}$/u)
  })
  .strict();

export type StoredMcpCredential = ProviderCredential | z.infer<typeof systemdCredentialSchema>;

const credentialSchema = z.discriminatedUnion("kind", [
  systemdCredentialSchema,
  z.object({ kind: z.literal("bearer"), value: z.string().min(1).max(16_384) }).strict(),
  z
    .object({
      kind: z.literal("http-header"),
      name: z.string().regex(/^[A-Za-z0-9-]{1,128}$/u),
      value: z.string().min(1).max(16_384)
    })
    .strict(),
  z
    .object({
      kind: z.literal("env"),
      name: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u),
      value: z.string().min(1).max(16_384)
    })
    .strict()
]);

export interface McpCredentialMetadata {
  readonly ref: string;
  readonly kind: ProviderCredential["kind"];
  readonly name?: string;
  readonly source?: "systemd";
}

export interface McpCredentialStore {
  list(): Promise<readonly McpCredentialMetadata[]>;
  set(ref: string, credential: StoredMcpCredential): Promise<McpCredentialMetadata>;
  remove(ref: string): Promise<boolean>;
  resolve(refs: readonly string[]): Promise<readonly ProviderCredential[]>;
}

function assertRef(ref: string): void {
  if (!REF_PATTERN.test(ref)) throw new Error("mcp_credential_ref_invalid");
}

function metadata(ref: string, credential: StoredMcpCredential): McpCredentialMetadata {
  if (credential.kind === "systemd-bearer")
    return Object.freeze({ ref, kind: "bearer", source: "systemd" });
  return Object.freeze({
    ref,
    kind: credential.kind,
    ...(credential.kind === "bearer" ? {} : { name: credential.name })
  });
}

export function createMcpCredentialStore(
  directory: string,
  options: { readonly systemdCredentialsRoot?: string } = {}
): McpCredentialStore {
  const systemdRoot = options.systemdCredentialsRoot ?? "/run/credentials";
  const resolveSystemd = async (
    credential: z.infer<typeof systemdCredentialSchema>
  ): Promise<ProviderCredential> => {
    if (process.platform !== "linux") throw new Error("mcp_systemd_credential_platform_invalid");
    const parent = join(systemdRoot, credential.unit);
    let handle;
    try {
      if ((await lstat(parent)).isSymbolicLink()) throw new Error("invalid");
      handle = await open(
        join(parent, credential.credential),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      const info = await handle.stat();
      if (
        !info.isFile() ||
        !(
          (info.uid === process.getuid?.() && (info.mode & 0o077) === 0) ||
          (info.uid === 0 && info.gid === 0 && (info.mode & 0o037) === 0)
        ) ||
        info.size > 16_384
      ) {
        throw new Error("invalid");
      }
      const buffer = Buffer.alloc(16_385);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const value = buffer.subarray(0, bytesRead).toString("utf8").trim();
      if (bytesRead > 16_384 || value.length === 0 || /[\s\u0000-\u001f\u007f]/u.test(value))
        throw new Error("invalid");
      return Object.freeze({ kind: "bearer", value });
    } catch {
      throw new Error("mcp_systemd_credential_unavailable");
    } finally {
      await handle?.close();
    }
  };
  const pathFor = (ref: string): string => {
    assertRef(ref);
    return join(directory, `${ref}.json`);
  };

  const readCredential = async (ref: string): Promise<StoredMcpCredential> => {
    const path = pathFor(ref);
    try {
      const info = await stat(path);
      if (process.platform === "win32") {
        ensureWindowsPrivateAcl(path, "file");
      } else if ((info.mode & 0o077) !== 0) {
        throw new Error("mcp_credential_file_permissions_invalid");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("mcp_credential_not_found");
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("mcp_credential_not_found");
      }
      throw new Error("mcp_credential_invalid");
    }
    const result = credentialSchema.safeParse(parsed);
    if (!result.success) throw new Error("mcp_credential_invalid");
    return Object.freeze({ ...result.data }) as StoredMcpCredential;
  };

  return Object.freeze({
    async list() {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const entries = await readdir(directory, { withFileTypes: true });
      const result: McpCredentialMetadata[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const ref = entry.name.slice(0, -5);
        if (!REF_PATTERN.test(ref)) continue;
        const credential = await readCredential(ref);
        result.push(metadata(ref, credential));
      }
      return Object.freeze(result.sort((left, right) => left.ref.localeCompare(right.ref)));
    },
    async set(ref: string, credential: StoredMcpCredential) {
      assertRef(ref);
      const validated = credentialSchema.safeParse(credential);
      if (!validated.success) throw new Error("mcp_credential_invalid");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") await chmod(directory, 0o700);
      else ensureWindowsPrivateAcl(directory, "directory");
      const target = pathFor(ref);
      const temporary = `${target}.tmp-${randomUUID()}`;
      try {
        await writeFile(temporary, `${JSON.stringify(validated.data)}\n`, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx"
        });
        await rename(temporary, target);
        if (process.platform !== "win32") await chmod(target, 0o600);
        else ensureWindowsPrivateAcl(target, "file");
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
      return metadata(ref, validated.data as StoredMcpCredential);
    },
    async remove(ref: string) {
      const path = pathFor(ref);
      try {
        await rm(path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    async resolve(refs: readonly string[]) {
      const unique = [...new Set(refs)];
      const credentials = await Promise.all(
        unique.map(async (ref) => {
          const credential = await readCredential(ref);
          return credential.kind === "systemd-bearer" ? resolveSystemd(credential) : credential;
        })
      );
      return Object.freeze(credentials);
    }
  });
}
