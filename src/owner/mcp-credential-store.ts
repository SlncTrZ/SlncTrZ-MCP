/**
 * MCP Credential Store — owner-managed provider secrets behind opaque references.
 * Raw values are only returned to the extension runtime resolver and never serialized to policy.
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod/v4";
import type { ProviderCredential } from "../extension/adapter.js";
import { ensureWindowsPrivateAcl } from "../shared/windows-private-acl.js";

const REF_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;

const credentialSchema = z.discriminatedUnion("kind", [
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
}

export interface McpCredentialStore {
  list(): Promise<readonly McpCredentialMetadata[]>;
  set(ref: string, credential: ProviderCredential): Promise<McpCredentialMetadata>;
  remove(ref: string): Promise<boolean>;
  resolve(refs: readonly string[]): Promise<readonly ProviderCredential[]>;
}

function assertRef(ref: string): void {
  if (!REF_PATTERN.test(ref)) throw new Error("mcp_credential_ref_invalid");
}

function metadata(ref: string, credential: ProviderCredential): McpCredentialMetadata {
  return Object.freeze({
    ref,
    kind: credential.kind,
    ...(credential.kind === "bearer" ? {} : { name: credential.name })
  });
}

export function createMcpCredentialStore(directory: string): McpCredentialStore {
  const pathFor = (ref: string): string => {
    assertRef(ref);
    return join(directory, `${ref}.json`);
  };

  const readCredential = async (ref: string): Promise<ProviderCredential> => {
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
    return Object.freeze({ ...result.data }) as ProviderCredential;
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
    async set(ref: string, credential: ProviderCredential) {
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
      return metadata(ref, validated.data as ProviderCredential);
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
      const credentials = await Promise.all(unique.map((ref) => readCredential(ref)));
      return Object.freeze(credentials);
    }
  });
}
