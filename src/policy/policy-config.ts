/**
 * Product policy — schema v2 contains only shared Paths.
 * Schema v1 is accepted at the file boundary solely for one-way migration.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import * as z from "zod/v4";
import type { ExtensionManifestV1 } from "../extension/manifest.js";
import { compileExtensionRegistry, type CompiledExtensionRegistry } from "../extension/registry.js";
import type { CompiledCommandCatalog } from "../kernel/command-catalog.js";
import { createKernelPolicySnapshot, type KernelPolicySnapshot } from "./kernel-policy.js";

export type PolicyConfigErrorCode =
  | "policy_file_missing"
  | "policy_file_invalid"
  | "policy_schema_invalid"
  | "policy_invalid"
  | "workspace_unknown"
  | "profile_unknown"
  | "workspace_denied"
  | "reload_in_progress";

export class PolicyConfigError extends Error {
  readonly code: PolicyConfigErrorCode;
  constructor(code: PolicyConfigErrorCode, message: string) {
    super(message);
    this.name = "PolicyConfigError";
    this.code = code;
  }
}

export type AuthorityMode = "restricted" | "autonomous";

export interface PolicyDocument {
  readonly schemaVersion: 2;
  readonly paths: readonly string[];
  readonly authorityMode?: AuthorityMode;
}

export interface CompiledPolicyInput {
  readonly schemaVersion: 2;
  readonly kernelPolicy: KernelPolicySnapshot;
  readonly extensionRegistry: CompiledExtensionRegistry;
}

const v2Schema = z
  .object({
    schemaVersion: z.literal(2),
    paths: z.array(z.string().min(1)).min(1).max(128),
    authorityMode: z.enum(["restricted", "autonomous"]).optional().default("restricted")
  })
  .strict();

const pathOrList = z.union([z.string().min(1), z.array(z.string().min(1))]);
const legacyWorkspaceSchema = z
  .object({
    id: z.string().min(1),
    paths: z.array(z.string().min(1)).optional(),
    roots: z
      .object({
        read: pathOrList.optional(),
        write: pathOrList.optional(),
        run: pathOrList.optional(),
        exec: z.string().min(1).optional()
      })
      .passthrough()
      .default({}),
    readAllowlist: z.array(z.string()).optional(),
    exec: z.unknown().optional(),
    profiles: z.array(z.string()).optional(),
    customCapabilities: z.array(z.string()).optional(),
    extensionGrants: z.array(z.unknown()).optional(),
    instructions: z.unknown().optional()
  })
  .passthrough();

const legacyV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    workspaces: z.array(legacyWorkspaceSchema),
    clientBindings: z.array(z.unknown()).optional(),
    fallbackWorkspaceId: z.string().optional(),
    extensions: z.array(z.unknown()).optional()
  })
  .passthrough();

function list(value: string | readonly string[] | undefined): string[] {
  return value === undefined ? [] : typeof value === "string" ? [value] : [...value];
}

function validatePaths(paths: readonly string[]): readonly string[] {
  const unique = [...new Set(paths)];
  if (unique.length === 0)
    throw new PolicyConfigError("policy_invalid", "At least one Path is required");
  for (const path of unique) {
    if (!isAbsolute(path))
      throw new PolicyConfigError("policy_invalid", "Every Path must be absolute");
  }
  return Object.freeze(unique);
}

function migrateLegacyV1(raw: z.infer<typeof legacyV1Schema>): PolicyDocument {
  const preferred =
    raw.workspaces.find((workspace) => workspace.id === "default") ??
    (raw.fallbackWorkspaceId === undefined
      ? undefined
      : raw.workspaces.find((workspace) => workspace.id === raw.fallbackWorkspaceId)) ??
    raw.workspaces.find((workspace) => workspace.id === "bootstrap") ??
    raw.workspaces[0];
  if (preferred === undefined) {
    throw new PolicyConfigError("policy_invalid", "Legacy policy has no workspace to migrate");
  }
  const paths = preferred.paths ?? [
    ...list(preferred.roots.read),
    ...list(preferred.roots.write),
    ...list(preferred.roots.run)
  ];
  return Object.freeze({
    schemaVersion: 2,
    paths: validatePaths(paths),
    authorityMode: "restricted"
  });
}

export function parsePolicyDocument(raw: unknown): PolicyDocument {
  const v2 = v2Schema.safeParse(raw);
  if (v2.success) {
    return Object.freeze({
      schemaVersion: 2,
      paths: validatePaths(v2.data.paths),
      authorityMode: v2.data.authorityMode
    });
  }
  const legacy = legacyV1Schema.safeParse(raw);
  if (legacy.success) return migrateLegacyV1(legacy.data);
  const issue = v2.error.issues[0] ?? legacy.error.issues[0];
  const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
  throw new PolicyConfigError(
    "policy_schema_invalid",
    `Policy document${where}: ${issue?.message ?? "invalid value"}`
  );
}

export async function loadPolicyDocument(policyFile: string): Promise<PolicyDocument> {
  let raw: string;
  try {
    raw = await readFile(policyFile, "utf8");
  } catch {
    throw new PolicyConfigError("policy_file_missing", "Policy file could not be read");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new PolicyConfigError("policy_file_invalid", "Policy file is not valid JSON");
  }
  return parsePolicyDocument(parsed);
}

export async function compilePolicyDocument(
  document: PolicyDocument,
  catalog?: CompiledCommandCatalog,
  extensions: readonly ExtensionManifestV1[] = []
): Promise<CompiledPolicyInput> {
  const paths = validatePaths(document.paths);
  return Object.freeze({
    schemaVersion: 2,
    kernelPolicy: createKernelPolicySnapshot({
      workspaceId: "default",
      authorityMode: document.authorityMode ?? "restricted",
      readRoots: paths,
      writeRoots: paths,
      runRoots: paths,
      ...(catalog === undefined ? {} : { commandCatalog: catalog })
    }),
    extensionRegistry: await compileExtensionRegistry(extensions)
  });
}
