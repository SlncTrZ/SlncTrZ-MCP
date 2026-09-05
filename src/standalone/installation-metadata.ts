/** Non-secret installation identity used by setup/lifecycle commands. */

import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import * as z from "zod/v4";

export type InstallMode = "user" | "system";
export type ServiceMode = "foreground" | "systemd";
export type SetupAuthorityMode = "restricted" | "autonomous";

export interface InstallationMetadata {
  readonly schemaVersion: 1;
  readonly installationId: string;
  readonly installMode: InstallMode;
  readonly installRoot: string;
  readonly stateRoot: string;
  readonly configRoot: string;
  readonly serviceMode: ServiceMode;
  readonly serviceName: string;
  readonly releaseChannel: string;
  readonly host: string;
  readonly port: number;
  readonly publicMcpUrl?: string;
  readonly authorityMode: SetupAuthorityMode;
  readonly initialPath: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const schema = z
  .object({
    schemaVersion: z.literal(1),
    installationId: z.string().uuid(),
    installMode: z.enum(["user", "system"]),
    installRoot: z.string().min(1),
    stateRoot: z.string().min(1),
    configRoot: z.string().min(1),
    serviceMode: z.enum(["foreground", "systemd"]),
    serviceName: z.string().min(1),
    releaseChannel: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65_535),
    publicMcpUrl: z.string().url().optional(),
    authorityMode: z.enum(["restricted", "autonomous"]),
    initialPath: z.string().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();

function validatePaths(metadata: InstallationMetadata): InstallationMetadata {
  for (const value of [
    metadata.installRoot,
    metadata.stateRoot,
    metadata.configRoot,
    metadata.initialPath
  ]) {
    if (!isAbsolute(value)) throw new Error("Installation metadata paths must be absolute");
  }
  return metadata;
}

export function parseInstallationMetadata(value: unknown): InstallationMetadata {
  const parsed = schema.parse(value) as InstallationMetadata;
  return Object.freeze(validatePaths(parsed));
}

export async function readInstallationMetadata(
  path: string
): Promise<InstallationMetadata | undefined> {
  try {
    return parseInstallationMetadata(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw new Error("Installation metadata is invalid JSON");
    throw error;
  }
}

export async function writeInstallationMetadata(
  path: string,
  input: Omit<InstallationMetadata, "schemaVersion" | "installationId" | "createdAt" | "updatedAt">,
  existing?: InstallationMetadata
): Promise<InstallationMetadata> {
  const now = new Date().toISOString();
  const metadata = parseInstallationMetadata({
    schemaVersion: 1,
    installationId: existing?.installationId ?? randomUUID(),
    ...input,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return metadata;
}
