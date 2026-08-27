/**
 * Kernel Policy Snapshot — immutable startup capability policy bound per request.
 * Wing: policy | Topic: kernel-capability-policy | Updated: 2026-08-27
 *
 * Provenance: SECURITY invariant 1, ARCHITECTURE §4.7, and THREAT_MODEL mutation gate.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isContainedPath } from "../kernel/fs-boundary.js";
import { type ExecCommandDefinition } from "../kernel/exec.js";

export type KernelCapability =
  "core.read" | "core.search" | "core.write" | "core.edit" | "core.exec";

export interface AuthenticatedPrincipal {
  readonly clientId: string;
  readonly scopes: readonly string[];
}

export interface KernelPolicyInput {
  readonly workspaceId: string;
  readonly readRoot?: string;
  readonly writeRoot?: string;
  readonly execRoot?: string;
  readonly execPath?: string;
  readonly execCommands?: readonly ExecCommandDefinition[];
}

export interface KernelPolicySnapshot {
  readonly version: string;
  readonly workspaceId: string;
  readonly capabilities: readonly KernelCapability[];
  readonly readRoot?: string;
  readonly writeRoot?: string;
  readonly execRoot?: string;
  readonly execPath?: string;
  readonly execCommands?: readonly ExecCommandDefinition[];
}

export interface AuthorizedExecCommand {
  readonly clientId: string;
  readonly workspaceId: string;
  readonly policyVersion: string;
  readonly execRoot: string;
  readonly command: ExecCommandDefinition;
}

export interface AuthorizedKernelContext {
  readonly clientId: string;
  readonly workspaceId: string;
  readonly policyVersion: string;
  readonly capability: KernelCapability;
  readonly root: string;
}

export type KernelPolicyErrorCode =
  "invalid_policy" | "unauthenticated" | "scope_denied" | "capability_denied";

export class KernelPolicyError extends Error {
  readonly code: KernelPolicyErrorCode;

  constructor(code: KernelPolicyErrorCode, message: string) {
    super(message);
    this.name = "KernelPolicyError";
    this.code = code;
  }
}

function validateRoot(root: string | undefined, name: string): string | undefined {
  if (root === undefined) return undefined;
  if (root.length === 0 || (!isAbsolute(root) && !/^[A-Za-z]:[\\/]/u.test(root))) {
    throw new KernelPolicyError("invalid_policy", `${name} must be an absolute path`);
  }
  return root;
}

function canonicalRoot(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function assertNoExecWriteOverlap(execRoot: string, writeRoot: string): void {
  const execReal = canonicalRoot(execRoot);
  const writeReal = canonicalRoot(writeRoot);
  if (isContainedPath(writeReal, execReal) || isContainedPath(execReal, writeReal)) {
    throw new KernelPolicyError("invalid_policy", "execRoot must not overlap writeRoot");
  }
}

/** Build one deeply immutable startup snapshot; no request reads policy from disk. */
export function createKernelPolicySnapshot(input: KernelPolicyInput): KernelPolicySnapshot {
  if (input.workspaceId.length === 0) {
    throw new KernelPolicyError("invalid_policy", "workspaceId must be non-empty");
  }

  const readRoot = validateRoot(input.readRoot, "readRoot");
  const writeRoot = validateRoot(input.writeRoot, "writeRoot");
  const execRoot = validateRoot(input.execRoot, "execRoot");
  const execPath = input.execPath;
  if (execPath !== undefined && execPath.includes("\0")) {
    throw new KernelPolicyError("invalid_policy", "execPath must not contain NUL bytes");
  }
  const execCommands = input.execCommands ?? [];

  if (execRoot !== undefined && writeRoot !== undefined) {
    assertNoExecWriteOverlap(execRoot, writeRoot);
  }

  const execEnabled =
    process.platform !== "win32" && execRoot !== undefined && execCommands.length > 0;
  const capabilities: KernelCapability[] = [];
  if (readRoot !== undefined) capabilities.push("core.read", "core.search");
  if (writeRoot !== undefined) capabilities.push("core.write", "core.edit");
  if (execEnabled) capabilities.push("core.exec");

  const canonical = JSON.stringify({
    workspaceId: input.workspaceId,
    readRoot: readRoot ?? null,
    writeRoot: writeRoot ?? null,
    execRoot: execEnabled ? execRoot : null,
    execPath: execEnabled ? (execPath ?? "") : null,
    execCommands: execEnabled ? execCommands : null,
    capabilities
  });
  const version = createHash("sha256").update(canonical).digest("hex").slice(0, 16);

  return Object.freeze({
    version,
    workspaceId: input.workspaceId,
    capabilities: Object.freeze(capabilities),
    ...(readRoot === undefined ? {} : { readRoot }),
    ...(writeRoot === undefined ? {} : { writeRoot }),
    ...(execEnabled
      ? { execRoot, execPath: execPath ?? "", execCommands: Object.freeze(execCommands) }
      : {})
  });
}

/** Authorize one capability for an authenticated MCP principal against one snapshot. */
export function authorizeKernelCapability(
  snapshot: KernelPolicySnapshot,
  principal: AuthenticatedPrincipal | undefined,
  capability: KernelCapability
): AuthorizedKernelContext {
  if (principal === undefined || principal.clientId.length === 0) {
    throw new KernelPolicyError("unauthenticated", "Authenticated client identity is required");
  }
  if (!principal.scopes.includes("mcp:tools")) {
    throw new KernelPolicyError("scope_denied", "Required MCP tool scope is missing");
  }
  if (!snapshot.capabilities.includes(capability)) {
    throw new KernelPolicyError("capability_denied", "Capability is not enabled by policy");
  }

  let root: string | undefined;
  if (capability === "core.read" || capability === "core.search") {
    root = snapshot.readRoot;
  } else if (capability === "core.write" || capability === "core.edit") {
    root = snapshot.writeRoot;
  } else {
    root = snapshot.execRoot;
  }
  if (root === undefined) {
    throw new KernelPolicyError("capability_denied", "Capability root is not configured");
  }

  return {
    clientId: principal.clientId,
    workspaceId: snapshot.workspaceId,
    policyVersion: snapshot.version,
    capability,
    root
  };
}

/** Authorize one specific command for an authenticated principal against one snapshot. */
export function authorizeKernelCommand(
  snapshot: KernelPolicySnapshot,
  principal: AuthenticatedPrincipal | undefined,
  commandId: string
): AuthorizedExecCommand {
  if (principal === undefined || principal.clientId.length === 0) {
    throw new KernelPolicyError("unauthenticated", "Authenticated client identity is required");
  }
  if (!principal.scopes.includes("mcp:tools")) {
    throw new KernelPolicyError("scope_denied", "Required MCP tool scope is missing");
  }
  if (!snapshot.capabilities.includes("core.exec")) {
    throw new KernelPolicyError("capability_denied", "Capability is not enabled by policy");
  }
  const execRoot = snapshot.execRoot;
  const command = (snapshot.execCommands ?? []).find((c) => c.commandId === commandId);
  if (execRoot === undefined || command === undefined) {
    throw new KernelPolicyError("capability_denied", "Command is not authorized");
  }

  return {
    clientId: principal.clientId,
    workspaceId: snapshot.workspaceId,
    policyVersion: snapshot.version,
    execRoot,
    command
  };
}
