/**
 * Extension Manifest — typed strict JSON provider declaration.
 * Wing: extension | Topic: manifest | Updated: 2026-08-27
 *
 * Provenance: PLAN Phase 5, ARCHITECTURE §4.11, ADR-020, and the Phase 5 handoff slice 1.
 *
 * A manifest declares one isolated third-party MCP provider. It is operator-owned JSON
 * with no inline secrets, shell strings, arbitrary caller endpoints, wildcard workspaces,
 * or unknown fields. Canonical tool IDs are stable and namespaced `providerId.toolName`;
 * any namespace mismatch or duplicate collides (a fatal candidate-policy error).
 */

import { isAbsolute } from "node:path";
import * as z from "zod/v4";
import { type RiskClass, isValidCanonicalId } from "../kernel/tool-identity.js";

export type ExtensionManifestErrorCode =
  "manifest_schema_invalid" | "manifest_invalid" | "manifest_collision";

export class ExtensionManifestError extends Error {
  readonly code: ExtensionManifestErrorCode;

  constructor(code: ExtensionManifestErrorCode, message: string) {
    super(message);
    this.name = "ExtensionManifestError";
    this.code = code;
  }
}

export const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
export const MAX_EXTENSIONS = 64;
export const MAX_TOOLS_PER_EXTENSION = 256;
export const MAX_WORKSPACES_PER_EXTENSION = 64;
export const MAX_ENV_ALLOWLIST_KEYS = 16;
export const MAX_CREDENTIAL_REFS = 16;

export const HARD_MAX_OUTPUT_BYTES = 8 * 1_048_576;
export const HARD_MAX_MESSAGE_BYTES = 1_048_576;
export const HARD_MAX_QUEUE = 512;
export const HARD_MAX_RESTARTS = 16;
export const HARD_MAX_STARTUP_TIMEOUT_MS = 120_000;
export const HARD_MAX_REQUEST_TIMEOUT_MS = 120_000;

export type ExtensionTransport = "stdio" | "streamable-http";

export interface ExtensionToolSchemaRecord {
  readonly canonicalId: string;
  readonly riskClass: RiskClass;
}

export interface ExtensionManifestV1 {
  readonly id: string;
  readonly transport: ExtensionTransport;
  readonly version: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly endpoint?: string;
  readonly tools: readonly ExtensionToolSchemaRecord[];
  readonly workspaces: readonly string[];
  readonly envAllowlist?: readonly string[];
  readonly credentialRefs?: readonly string[];
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxMessageBytes?: number;
  readonly maxQueue?: number;
  readonly maxRestarts?: number;
}

export interface CompiledExtensionTool {
  readonly canonicalId: string;
  readonly exposedName: string;
  readonly riskClass: RiskClass;
  readonly providerId: string;
}

export interface CompiledExtensionManifest {
  readonly id: string;
  readonly transport: ExtensionTransport;
  readonly version: string;
  readonly command?: string;
  readonly args: readonly string[];
  readonly endpoint?: string;
  readonly tools: readonly CompiledExtensionTool[];
  readonly workspaces: readonly string[];
  readonly envAllowlist: readonly string[];
  readonly credentialRefs: readonly string[];
  readonly startupTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxMessageBytes: number;
  readonly maxQueue: number;
  readonly maxRestarts: number;
}

const toolRecordSchema = z
  .object({
    canonicalId: z.string().min(1),
    riskClass: z.enum(["read", "write", "execute", "network", "admin"])
  })
  .strict();

const manifestSchema = z
  .object({
    id: z.string().regex(EXTENSION_ID_PATTERN),
    transport: z.enum(["stdio", "streamable-http"]),
    version: z.string().min(1),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    endpoint: z.string().min(1).optional(),
    tools: z.array(toolRecordSchema).min(1).max(MAX_TOOLS_PER_EXTENSION),
    workspaces: z.array(z.string()).min(0).max(MAX_WORKSPACES_PER_EXTENSION),
    envAllowlist: z.array(z.string()).max(MAX_ENV_ALLOWLIST_KEYS).optional(),
    credentialRefs: z.array(z.string()).max(MAX_CREDENTIAL_REFS).optional(),
    startupTimeoutMs: z.number().int().positive().optional(),
    requestTimeoutMs: z.number().int().positive().optional(),
    maxOutputBytes: z.number().int().positive().optional(),
    maxMessageBytes: z.number().int().positive().optional(),
    maxQueue: z.number().int().positive().optional(),
    maxRestarts: z.number().int().nonnegative().optional()
  })
  .strict();

const WORKSPACE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

function mapZodError(error: z.ZodError): ExtensionManifestError {
  const issue = error.issues[0];
  const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
  const what = issue?.message ?? "invalid value";
  return new ExtensionManifestError("manifest_schema_invalid", `Manifest${where}: ${what}`);
}

/** True if a candidate value looks like a live secret (never echo it back). */
function looksLikeSecret(value: string): boolean {
  return /sk_live|AKIA|BEGIN (RSA|OPENSSH|PRIVATE)|-----BEGIN|ghp_|xox[baprs]-/iu.test(value);
}

/** Compile and validate one extension manifest into a frozen, operator-controlled record. */
export async function compileExtensionManifest(
  manifest: ExtensionManifestV1
): Promise<CompiledExtensionManifest> {
  const parsed = manifestSchema.safeParse(manifest);
  if (!parsed.success) throw mapZodError(parsed.error);

  const id = parsed.data.id;
  const transport = parsed.data.transport;

  // Reject fields mixed across transports: stdio has no endpoint, HTTP no command/args.
  if (transport === "stdio" && parsed.data.endpoint !== undefined) {
    throw new ExtensionManifestError("manifest_invalid", "Stdio transport must not set endpoint");
  }
  if (
    transport === "streamable-http" &&
    (parsed.data.command !== undefined || parsed.data.args !== undefined)
  ) {
    throw new ExtensionManifestError(
      "manifest_invalid",
      "HTTP transport must not set command/args"
    );
  }

  // Hard ceilings: an operator may not request unbounded output, message, queue or retries.
  const output = parsed.data.maxOutputBytes;
  const message = parsed.data.maxMessageBytes;
  const queue = parsed.data.maxQueue;
  const restarts = parsed.data.maxRestarts;
  const startup = parsed.data.startupTimeoutMs;
  const request = parsed.data.requestTimeoutMs;
  if (output !== undefined && output > HARD_MAX_OUTPUT_BYTES) {
    throw new ExtensionManifestError("manifest_invalid", "maxOutputBytes exceeds the hard ceiling");
  }
  if (message !== undefined && message > HARD_MAX_MESSAGE_BYTES) {
    throw new ExtensionManifestError(
      "manifest_invalid",
      "maxMessageBytes exceeds the hard ceiling"
    );
  }
  if (queue !== undefined && queue > HARD_MAX_QUEUE) {
    throw new ExtensionManifestError("manifest_invalid", "maxQueue exceeds the hard ceiling");
  }
  if (restarts !== undefined && restarts > HARD_MAX_RESTARTS) {
    throw new ExtensionManifestError("manifest_invalid", "maxRestarts exceeds the hard ceiling");
  }
  if (startup !== undefined && startup > HARD_MAX_STARTUP_TIMEOUT_MS) {
    throw new ExtensionManifestError(
      "manifest_invalid",
      "startupTimeoutMs exceeds the hard ceiling"
    );
  }
  if (request !== undefined && request > HARD_MAX_REQUEST_TIMEOUT_MS) {
    throw new ExtensionManifestError(
      "manifest_invalid",
      "requestTimeoutMs exceeds the hard ceiling"
    );
  }

  if (transport === "stdio") {
    const command = parsed.data.command;
    if (command === undefined) {
      throw new ExtensionManifestError("manifest_invalid", "Stdio transport requires a command");
    }
    if (
      command.includes(";") ||
      command.includes("|") ||
      command.includes("&") ||
      command.includes("$(")
    ) {
      throw new ExtensionManifestError("manifest_invalid", "Command must not be a shell string");
    }
    if (/[\n\r\t\0]/u.test(command)) {
      throw new ExtensionManifestError(
        "manifest_invalid",
        "Command must not contain control characters"
      );
    }
    if (!isAbsolute(command)) {
      throw new ExtensionManifestError("manifest_invalid", "Command must be an absolute path");
    }
  }

  if (parsed.data.transport === "streamable-http") {
    const endpoint = parsed.data.endpoint;
    if (endpoint === undefined) {
      throw new ExtensionManifestError("manifest_invalid", "HTTP transport requires an endpoint");
    }
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new ExtensionManifestError("manifest_invalid", "HTTP endpoint is not a valid URL");
    }
    if (url.protocol !== "https:") {
      throw new ExtensionManifestError("manifest_invalid", "HTTP endpoint must use HTTPS");
    }
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
      throw new ExtensionManifestError(
        "manifest_invalid",
        "HTTP endpoint must not carry inline credentials, query or fragment"
      );
    }
  }

  for (const workspace of parsed.data.workspaces) {
    if (!WORKSPACE_PATTERN.test(workspace)) {
      throw new ExtensionManifestError("manifest_invalid", "Workspace id is invalid");
    }
  }

  for (const ref of parsed.data.credentialRefs ?? []) {
    if (looksLikeSecret(ref)) {
      throw new ExtensionManifestError("manifest_invalid", "Credential ref must be an opaque name");
    }
  }

  const tools: CompiledExtensionTool[] = parsed.data.tools.map((tool) => {
    // Format validation only; namespace match (providerId.toolName) is a registry concern.
    if (
      !isValidCanonicalId(tool.canonicalId) ||
      tool.canonicalId.endsWith(".") ||
      tool.canonicalId.includes("..") ||
      /\s/iu.test(tool.canonicalId) ||
      /[\u0000-\u001f]/u.test(tool.canonicalId)
    ) {
      throw new ExtensionManifestError("manifest_invalid", "Canonical tool id is invalid");
    }
    const exposedName = tool.canonicalId;
    return Object.freeze({
      canonicalId: tool.canonicalId,
      exposedName,
      riskClass: tool.riskClass,
      providerId: id
    });
  });

  // Duplicate tool names within one provider are fatal.
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.canonicalId)) {
      throw new ExtensionManifestError("manifest_collision", "Duplicate tool id in manifest");
    }
    seen.add(tool.canonicalId);
  }

  return Object.freeze({
    id,
    transport: parsed.data.transport,
    version: parsed.data.version,
    ...(parsed.data.command === undefined ? {} : { command: parsed.data.command }),
    args: Object.freeze([...(parsed.data.args ?? [])]),
    ...(parsed.data.endpoint === undefined ? {} : { endpoint: parsed.data.endpoint }),
    tools: Object.freeze(tools),
    workspaces: Object.freeze([...parsed.data.workspaces]),
    envAllowlist: Object.freeze([...(parsed.data.envAllowlist ?? [])]),
    credentialRefs: Object.freeze([...(parsed.data.credentialRefs ?? [])]),
    startupTimeoutMs: parsed.data.startupTimeoutMs ?? 10_000,
    requestTimeoutMs: parsed.data.requestTimeoutMs ?? 30_000,
    maxOutputBytes: parsed.data.maxOutputBytes ?? 1_048_576,
    maxMessageBytes: parsed.data.maxMessageBytes ?? 65_536,
    maxQueue: parsed.data.maxQueue ?? 16,
    maxRestarts: parsed.data.maxRestarts ?? 3
  });
}
