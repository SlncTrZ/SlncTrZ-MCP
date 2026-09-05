/** Kernel authorization snapshot for shared Paths + command.json. */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isContainedPath } from "../kernel/fs-boundary.js";
import {
  type CompiledCommandCatalog,
  matchCatalogCommand,
  resolveCommandBinary
} from "../kernel/command-catalog.js";
import { type RiskClass } from "../kernel/tool-identity.js";
import { type ExtensionRuntimeCatalog } from "../extension/runtime.js";

export type KernelCapability =
  "core.read" | "core.search" | "core.write" | "core.edit" | "core.exec";
export type AuthorityMode = "restricted" | "autonomous";

export interface AuthenticatedPrincipal {
  readonly clientId: string;
  readonly scopes: readonly string[];
}

export interface KernelPolicyInput {
  readonly workspaceId: string;
  readonly authorityMode?: AuthorityMode;
  readonly readRoot?: string;
  readonly readRoots?: readonly string[];
  readonly readAllowlist?: readonly string[];
  readonly writeRoot?: string;
  readonly writeRoots?: readonly string[];
  readonly runRoots?: readonly string[];
  readonly commandCatalog?: CompiledCommandCatalog;
}

export interface KernelPolicySnapshot {
  readonly version: string;
  readonly workspaceId: string;
  readonly authorityMode: AuthorityMode;
  readonly capabilities: readonly KernelCapability[];
  readonly readRoot?: string;
  readonly readRoots?: readonly string[];
  readonly readAllowlist?: readonly string[];
  readonly writeRoot?: string;
  readonly writeRoots?: readonly string[];
  readonly runRoots?: readonly string[];
  readonly commandCatalog?: CompiledCommandCatalog;
  readonly extensions: readonly ResolvedExtensionTool[];
  readonly extensionRuntime?: ExtensionRuntimeCatalog;
  readonly toolCatalogFingerprint?: string;
}

export interface ResolvedExtensionTool {
  readonly canonicalId: string;
  readonly providerId: string;
  readonly riskClass: RiskClass;
  readonly description?: string;
}

export interface AuthorizedKernelContext {
  readonly clientId: string;
  readonly workspaceId: string;
  readonly policyVersion: string;
  readonly authorityMode: AuthorityMode;
  readonly capability: KernelCapability;
  readonly root: string;
  readonly readRoots?: readonly string[];
  readonly writeRoots?: readonly string[];
  readonly readAllowlist?: readonly string[];
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

function validateRoot(root: string, name: string): string {
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

function roots(values: readonly string[] | undefined, single: string | undefined, label: string) {
  return (values ?? (single === undefined ? [] : [single])).map((value) =>
    validateRoot(value, label)
  );
}

export function createKernelPolicySnapshot(input: KernelPolicyInput): KernelPolicySnapshot {
  if (input.workspaceId.length === 0) {
    throw new KernelPolicyError("invalid_policy", "workspaceId must be non-empty");
  }
  const authorityMode = input.authorityMode ?? "restricted";
  const readRoots = roots(input.readRoots, input.readRoot, "readRoot");
  const writeRoots = roots(input.writeRoots, input.writeRoot, "writeRoot");
  const runRoots = roots(input.runRoots, undefined, "runRoot");
  const execEnabled =
    authorityMode === "autonomous" ||
    (runRoots.length > 0 &&
      input.commandCatalog !== undefined &&
      input.commandCatalog.rules.length > 0);
  const capabilities: KernelCapability[] = [];
  if (authorityMode === "autonomous" || readRoots.length > 0) {
    capabilities.push("core.read", "core.search");
  }
  if (authorityMode === "autonomous" || writeRoots.length > 0) {
    capabilities.push("core.write", "core.edit");
  }
  if (execEnabled) capabilities.push("core.exec");
  const canonical = JSON.stringify({
    workspaceId: input.workspaceId,
    authorityMode,
    readRoots,
    readAllowlist: input.readAllowlist ?? null,
    writeRoots,
    runRoots,
    commandCatalog:
      input.commandCatalog?.rules.map((rule) =>
        rule.kind === "general"
          ? [rule.command, rule.binary]
          : [rule.command, rule.binary, ...rule.subcommands]
      ) ?? null,
    capabilities
  });
  const version = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return Object.freeze({
    version,
    workspaceId: input.workspaceId,
    authorityMode,
    capabilities: Object.freeze(capabilities),
    extensions: Object.freeze([]),
    ...(readRoots.length === 0
      ? {}
      : { readRoot: readRoots[0], readRoots: Object.freeze([...readRoots]) }),
    ...(input.readAllowlist === undefined
      ? {}
      : { readAllowlist: Object.freeze([...input.readAllowlist]) }),
    ...(writeRoots.length === 0
      ? {}
      : { writeRoot: writeRoots[0], writeRoots: Object.freeze([...writeRoots]) }),
    ...(runRoots.length === 0 ? {} : { runRoots: Object.freeze([...runRoots]) }),
    ...(input.commandCatalog === undefined ? {} : { commandCatalog: input.commandCatalog })
  });
}

function requirePrincipal(principal: AuthenticatedPrincipal | undefined): AuthenticatedPrincipal {
  if (principal === undefined || principal.clientId.length === 0) {
    throw new KernelPolicyError("unauthenticated", "Authenticated client identity is required");
  }
  if (!principal.scopes.includes("mcp:tools")) {
    throw new KernelPolicyError("scope_denied", "Required MCP tool scope is missing");
  }
  return principal;
}

export function authorizeRunKernelCommand(
  snapshot: KernelPolicySnapshot,
  principal: AuthenticatedPrincipal | undefined,
  command: string,
  firstArg: string | undefined,
  root?: string
): { readonly runRoot: string; readonly binary: string } {
  requirePrincipal(principal);
  if (!snapshot.capabilities.includes("core.exec")) {
    throw new KernelPolicyError("capability_denied", "Capability is not enabled by policy");
  }

  if (snapshot.authorityMode === "autonomous") {
    let binary: string;
    try {
      binary = resolveCommandBinary(command);
    } catch {
      throw new KernelPolicyError("capability_denied", "Command could not be resolved");
    }
    const runRoot =
      root === undefined
        ? (snapshot.runRoots?.[0] ?? process.cwd())
        : canonicalRoot(validateRoot(root, "runRoot"));
    return { runRoot, binary };
  }

  const catalog = snapshot.commandCatalog;
  const runRoots = snapshot.runRoots ?? [];
  if (catalog === undefined || runRoots.length === 0) {
    throw new KernelPolicyError("capability_denied", "core.exec is not configured");
  }
  const matched = matchCatalogCommand(catalog, command, firstArg);
  if (matched === undefined) {
    throw new KernelPolicyError("capability_denied", "Command is not authorized");
  }
  let selected: string | undefined;
  if (root !== undefined) {
    const requested = canonicalRoot(root);
    const allowed = runRoots.find((candidate) =>
      isContainedPath(canonicalRoot(candidate), requested)
    );
    if (allowed === undefined) {
      throw new KernelPolicyError("capability_denied", "Run root is not authorized");
    }
    selected = requested;
  } else if (runRoots.length === 1) {
    selected = runRoots[0];
  } else {
    throw new KernelPolicyError("capability_denied", "Run root selection is required");
  }
  if (selected === undefined) {
    throw new KernelPolicyError("capability_denied", "Run root is not configured");
  }
  return { runRoot: selected, binary: matched.binary };
}

export function authorizeKernelCapability(
  snapshot: KernelPolicySnapshot,
  principal: AuthenticatedPrincipal | undefined,
  capability: KernelCapability
): AuthorizedKernelContext {
  const authenticated = requirePrincipal(principal);
  if (!snapshot.capabilities.includes(capability)) {
    throw new KernelPolicyError("capability_denied", "Capability is not enabled by policy");
  }

  if (snapshot.authorityMode === "autonomous") {
    const root =
      capability === "core.read" || capability === "core.search"
        ? (snapshot.readRoot ?? process.cwd())
        : capability === "core.write" || capability === "core.edit"
          ? (snapshot.writeRoot ?? process.cwd())
          : (snapshot.runRoots?.[0] ?? process.cwd());
    return {
      clientId: authenticated.clientId,
      workspaceId: snapshot.workspaceId,
      policyVersion: snapshot.version,
      authorityMode: snapshot.authorityMode,
      capability,
      root
    };
  }

  const root =
    capability === "core.read" || capability === "core.search"
      ? snapshot.readRoot
      : capability === "core.write" || capability === "core.edit"
        ? snapshot.writeRoot
        : snapshot.runRoots?.[0];
  if (root === undefined) {
    throw new KernelPolicyError("capability_denied", "Capability root is not configured");
  }
  return {
    clientId: authenticated.clientId,
    workspaceId: snapshot.workspaceId,
    policyVersion: snapshot.version,
    authorityMode: snapshot.authorityMode,
    capability,
    root,
    ...(capability === "core.read" || capability === "core.search"
      ? {
          ...(snapshot.readRoots === undefined ? {} : { readRoots: snapshot.readRoots }),
          ...(snapshot.readAllowlist === undefined ? {} : { readAllowlist: snapshot.readAllowlist })
        }
      : capability === "core.write" || capability === "core.edit"
        ? snapshot.writeRoots === undefined
          ? {}
          : { writeRoots: snapshot.writeRoots }
        : {})
  };
}
