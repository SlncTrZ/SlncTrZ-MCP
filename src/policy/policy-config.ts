/**
 * Typed Policy Config — versioned JSON workspace policy with explicit bindings.
 * Wing: policy | Topic: policy-config | Updated: 2026-08-27
 *
 * Provenance: PLAN Phase 4, ARCHITECTURE §4.7, ADR-018, and the Phase 4 handoff slice 1.
 *
 * The policy file is operator-owned absolute JSON. It is compiled once into an
 * immutable, versioned snapshot input; no tool or MCP handler reads it from disk.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import * as z from "zod/v4";
import {
  parseExecCommandRegistry,
  validateExecCommandRegistry,
  type ExecCommandDefinition
} from "../kernel/exec.js";
import {
  createKernelPolicySnapshot,
  type KernelCapability,
  type KernelPolicySnapshot
} from "./kernel-policy.js";

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

export const WORKSPACE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const MAX_WORKSPACES = 128;
export const MAX_CLIENT_BINDINGS = 128;
export const MAX_WORKSPACE_IDS_PER_BINDING = 32;
export const MAX_PROFILES_PER_WORKSPACE = 16;

export const PROFILE_NAMES = ["read-only", "minimal", "custom"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

export const KERNEL_CAPABILITY_NAMES = [
  "core.read",
  "core.search",
  "core.write",
  "core.edit",
  "core.exec"
] as const;

export interface WorkspaceDefinition {
  readonly id: string;
  readonly roots: { readonly read?: string; readonly write?: string; readonly exec?: string };
  readonly exec?: { readonly commandsFile: string; readonly path?: string };
  readonly profiles: readonly ProfileName[];
  readonly customCapabilities?: readonly KernelCapability[];
}

export interface ClientWorkspaceBinding {
  readonly clientId: string;
  readonly workspaceIds: readonly string[];
  readonly defaultWorkspaceId?: string;
}

export interface PolicyDocumentV1 {
  readonly schemaVersion: 1;
  readonly workspaces: readonly WorkspaceDefinition[];
  readonly clientBindings?: readonly ClientWorkspaceBinding[];
}

export interface CompiledWorkspace {
  readonly id: string;
  readonly profiles: readonly ProfileName[];
  readonly customCapabilities: readonly KernelCapability[];
  readonly kernelPolicy: KernelPolicySnapshot;
}

export interface CompiledBinding {
  readonly clientId: string;
  readonly workspaceIds: readonly string[];
  readonly defaultWorkspaceId?: string;
}

export interface CompiledPolicyInput {
  readonly schemaVersion: 1;
  readonly workspaces: readonly CompiledWorkspace[];
  readonly clientBindings: readonly CompiledBinding[];
}

const rootSchema = z
  .object({
    read: z.string().min(1).optional(),
    write: z.string().min(1).optional(),
    exec: z.string().min(1).optional()
  })
  .strict();

const workspaceSchema = z
  .object({
    id: z.string().regex(WORKSPACE_ID_PATTERN),
    roots: rootSchema,
    exec: z
      .object({ commandsFile: z.string().min(1), path: z.string().min(1).optional() })
      .strict()
      .optional(),
    profiles: z.array(z.enum(PROFILE_NAMES)).min(1),
    customCapabilities: z.array(z.enum(KERNEL_CAPABILITY_NAMES)).optional()
  })
  .strict();

const bindingSchema = z
  .object({
    clientId: z.string().min(1),
    workspaceIds: z.array(z.string().min(1)).min(1).max(MAX_WORKSPACE_IDS_PER_BINDING),
    defaultWorkspaceId: z.string().min(1).optional()
  })
  .strict();

const policySchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaces: z.array(workspaceSchema).max(MAX_WORKSPACES),
    clientBindings: z.array(bindingSchema).max(MAX_CLIENT_BINDINGS).optional()
  })
  .strict();

function mapZodError(error: z.ZodError): PolicyConfigError {
  const issue = error.issues[0];
  const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
  const what = issue?.message ?? "invalid value";
  return new PolicyConfigError("policy_schema_invalid", `Policy document${where}: ${what}`);
}

function assertAbsolute(pathValue: string, label: string): void {
  if (!isAbsolute(pathValue)) {
    throw new PolicyConfigError("policy_invalid", `${label} must be an absolute path`);
  }
}

/** Read and parse the policy file into a typed, schema-validated document. */
export async function loadPolicyDocument(policyFile: string): Promise<PolicyDocumentV1> {
  let raw: string;
  try {
    raw = await readFile(policyFile, "utf8");
  } catch {
    throw new PolicyConfigError("policy_file_missing", "Policy file could not be read");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PolicyConfigError("policy_file_invalid", "Policy file is not valid JSON");
  }

  const result = policySchema.safeParse(parsed);
  if (!result.success) throw mapZodError(result.error);
  return result.data as PolicyDocumentV1;
}

async function compileWorkspace(workspace: WorkspaceDefinition): Promise<CompiledWorkspace> {
  const roots = workspace.roots;
  const hasAnyRoot =
    roots.read !== undefined || roots.write !== undefined || roots.exec !== undefined;
  if (!hasAnyRoot) {
    throw new PolicyConfigError("policy_invalid", `Workspace ${workspace.id} has no root`);
  }
  if (roots.read !== undefined) assertAbsolute(roots.read, "read root");
  if (roots.write !== undefined) assertAbsolute(roots.write, "write root");
  if (roots.exec !== undefined) assertAbsolute(roots.exec, "exec root");

  if (workspace.exec !== undefined && roots.exec === undefined) {
    throw new PolicyConfigError(
      "policy_invalid",
      `Workspace ${workspace.id} has exec without exec root`
    );
  }
  if (workspace.exec === undefined && roots.exec !== undefined) {
    throw new PolicyConfigError(
      "policy_invalid",
      `Workspace ${workspace.id} has exec root without exec`
    );
  }

  const profileSet = new Set<string>();
  for (const profile of workspace.profiles) {
    if (profileSet.has(profile)) {
      throw new PolicyConfigError(
        "policy_invalid",
        `Workspace ${workspace.id} repeats profile ${profile}`
      );
    }
    profileSet.add(profile);
  }
  if (workspace.profiles.length > MAX_PROFILES_PER_WORKSPACE) {
    throw new PolicyConfigError(
      "policy_invalid",
      `Workspace ${workspace.id} exceeds profile ceiling`
    );
  }
  if (
    workspace.profiles.includes("custom") &&
    (workspace.customCapabilities === undefined || workspace.customCapabilities.length === 0)
  ) {
    throw new PolicyConfigError(
      "policy_invalid",
      `Workspace ${workspace.id} custom profile lacks capabilities`
    );
  }

  let execCommands: readonly ExecCommandDefinition[] | undefined;
  let execRootForCommands: string | undefined;
  if (workspace.exec !== undefined && roots.exec !== undefined) {
    assertAbsolute(workspace.exec.commandsFile, "exec commands file");
    const validated = await validateExecCommandRegistryForWorkspace(
      roots.exec,
      workspace.exec.commandsFile
    );
    execCommands = validated.commands;
    execRootForCommands = validated.execRootReal;
    if (validated.commands.length === 0) {
      throw new PolicyConfigError(
        "policy_invalid",
        `Workspace ${workspace.id} exec has zero commands`
      );
    }
  }

  const kernelPolicy = createKernelPolicySnapshot({
    workspaceId: workspace.id,
    ...(roots.read === undefined ? {} : { readRoot: roots.read }),
    ...(roots.write === undefined ? {} : { writeRoot: roots.write }),
    ...(roots.exec === undefined || execRootForCommands === undefined
      ? {}
      : { execRoot: execRootForCommands }),
    ...(workspace.exec?.path === undefined ? {} : { execPath: workspace.exec.path }),
    ...(execCommands === undefined ? {} : { execCommands })
  });

  return Object.freeze({
    id: workspace.id,
    profiles: Object.freeze([...workspace.profiles]),
    customCapabilities: Object.freeze([...(workspace.customCapabilities ?? [])]),
    kernelPolicy
  });
}

async function validateExecCommandRegistryForWorkspace(
  execRoot: string,
  commandsFile: string
): Promise<{ readonly execRootReal: string; readonly commands: readonly ExecCommandDefinition[] }> {
  let raw: string;
  try {
    raw = await readFile(commandsFile, "utf8");
  } catch {
    throw new PolicyConfigError("policy_invalid", "Exec commands file could not be read");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PolicyConfigError("policy_invalid", "Exec commands file is not valid JSON");
  }
  return validateExecCommandRegistry(execRoot, parseExecCommandRegistry(parsed));
}

/** Compile a validated policy document into a deeply immutable, versioned snapshot input. */
export async function compilePolicyDocument(
  document: PolicyDocumentV1
): Promise<CompiledPolicyInput> {
  if (document.schemaVersion !== 1) {
    throw new PolicyConfigError("policy_schema_invalid", "Unsupported policy schema version");
  }
  const workspaceIds = new Set<string>();
  const workspaces: CompiledWorkspace[] = [];
  for (const workspace of document.workspaces) {
    if (workspaceIds.has(workspace.id)) {
      throw new PolicyConfigError("policy_invalid", `Duplicate workspace ${workspace.id}`);
    }
    workspaceIds.add(workspace.id);
    workspaces.push(await compileWorkspace(workspace));
  }

  const bindings: CompiledBinding[] = [];
  const clientIds = new Set<string>();
  for (const binding of document.clientBindings ?? []) {
    const seen = new Set<string>();
    if (clientIds.has(binding.clientId)) {
      throw new PolicyConfigError("policy_invalid", `Duplicate client binding ${binding.clientId}`);
    }
    clientIds.add(binding.clientId);
    for (const wid of binding.workspaceIds) {
      if (!workspaceIds.has(wid)) {
        throw new PolicyConfigError(
          "policy_invalid",
          `Binding ${binding.clientId} targets unknown workspace ${wid}`
        );
      }
      if (seen.has(wid)) {
        throw new PolicyConfigError(
          "policy_invalid",
          `Binding ${binding.clientId} repeats workspace ${wid}`
        );
      }
      seen.add(wid);
    }
    if (
      binding.defaultWorkspaceId !== undefined &&
      !binding.workspaceIds.includes(binding.defaultWorkspaceId)
    ) {
      throw new PolicyConfigError(
        "policy_invalid",
        `Binding ${binding.clientId} default outside its workspace set`
      );
    }
    bindings.push(
      Object.freeze({
        clientId: binding.clientId,
        workspaceIds: Object.freeze([...binding.workspaceIds]),
        ...(binding.defaultWorkspaceId === undefined
          ? {}
          : { defaultWorkspaceId: binding.defaultWorkspaceId })
      })
    );
  }

  return Object.freeze({
    schemaVersion: 1,
    workspaces: Object.freeze(workspaces),
    clientBindings: Object.freeze(bindings)
  });
}
