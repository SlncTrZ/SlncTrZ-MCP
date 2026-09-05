/**
 * Runtime Configuration — validates the minimal public ingress environment.
 * Wing: app | Topic: runtime-config | Updated: 2026-08-27
 *
 * Provenance: PLAN Phases 1 and 3, SECURITY default-deny, and ADR-015.
 */

import { isAbsolute } from "node:path";
import { managedStatePaths } from "../owner/managed-state.js";

export interface RuntimeConfig {
  readonly host: string;
  readonly port: number;
  readonly publicMcpUrl: URL;
  readonly ownerSecretHash?: string;
  readonly maxDynamicClients: number;
  readonly controlHost: "127.0.0.1" | "::1";
  readonly controlPort: number;
  readonly telemetryEnabled: boolean;
  readonly ownerWebEnabled: boolean;
  readonly allowedHostnames: readonly string[];
  readonly allowedOriginHostnames: readonly string[];
  readonly stateRoot?: string;
  readonly policyFile?: string;
  readonly staticClient?: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly clientName: string;
    readonly redirectUris: readonly string[];
  };
}

function parseCsv(value: string | undefined, fallback: readonly string[]): string[] {
  if (value === undefined) return [...fallback];
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) throw new Error("Configured allowlist cannot be empty");
  return entries;
}

/** Parse non-secret runtime settings. No dotenv file is read implicitly. */
export function readRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const host = environment.SLNCTRZ_HOST ?? "127.0.0.1";
  const rawPort = environment.SLNCTRZ_PORT ?? "3100";
  const port = Number(rawPort);

  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SLNCTRZ_PORT must be an integer from 1 to 65535");
  }

  const controlHost = environment.SLNCTRZ_CONTROL_HOST ?? "127.0.0.1";
  if (controlHost !== "127.0.0.1" && controlHost !== "::1") {
    throw new Error("SLNCTRZ_CONTROL_HOST must be a loopback IP literal");
  }
  const controlPort = Number(environment.SLNCTRZ_CONTROL_PORT ?? "3101");
  if (!Number.isSafeInteger(controlPort) || controlPort < 0 || controlPort > 65_535) {
    throw new Error("SLNCTRZ_CONTROL_PORT must be an integer from 0 to 65535");
  }
  const rawPublicUrl = environment.SLNCTRZ_PUBLIC_URL;

  const telemetryValue = environment.SLNCTRZ_TELEMETRY_ENABLED ?? "true";
  if (telemetryValue !== "true" && telemetryValue !== "false") {
    throw new Error("SLNCTRZ_TELEMETRY_ENABLED must be true or false");
  }
  const telemetryEnabled = telemetryValue === "true";
  const ownerWebValue =
    environment.SLNCTRZ_OWNER_WEB_ENABLED ?? (rawPublicUrl === undefined ? "true" : "false");
  if (ownerWebValue !== "true" && ownerWebValue !== "false") {
    throw new Error("SLNCTRZ_OWNER_WEB_ENABLED must be true or false");
  }
  const ownerWebEnabled = ownerWebValue === "true";

  const maxDynamicClients = Number(environment.SLNCTRZ_MAX_DYNAMIC_CLIENTS ?? "1024");
  if (!Number.isSafeInteger(maxDynamicClients) || maxDynamicClients <= 0) {
    throw new Error("SLNCTRZ_MAX_DYNAMIC_CLIENTS must be a positive integer");
  }

  let publicMcpUrl: URL;
  if (rawPublicUrl === undefined) {
    const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
    if (!loopback) {
      throw new Error("SLNCTRZ_PUBLIC_URL is required when SLNCTRZ_HOST is not loopback");
    }
    const localHost = host === "::1" ? "[::1]" : host;
    publicMcpUrl = new URL(`http://${localHost}:${port}/mcp`);
  } else {
    try {
      publicMcpUrl = new URL(rawPublicUrl);
    } catch {
      throw new Error("SLNCTRZ_PUBLIC_URL is not a valid URL");
    }
    if (
      publicMcpUrl.protocol !== "https:" ||
      publicMcpUrl.pathname !== "/mcp" ||
      publicMcpUrl.search.length > 0 ||
      publicMcpUrl.hash.length > 0 ||
      publicMcpUrl.username.length > 0 ||
      publicMcpUrl.password.length > 0
    ) {
      throw new Error("SLNCTRZ_PUBLIC_URL must be an HTTPS URL ending at /mcp");
    }
  }

  const ownerSecretHash = environment.SLNCTRZ_OWNER_SECRET_HASH;

  // Optional pre-registered confidential client for static-credential flows.
  const clientId = environment.SLNCTRZ_CLIENT_ID;
  const clientSecret = environment.SLNCTRZ_CLIENT_SECRET;
  if ((clientId === undefined) !== (clientSecret === undefined)) {
    throw new Error("SLNCTRZ_CLIENT_ID and SLNCTRZ_CLIENT_SECRET must be configured together");
  }
  let staticClient: RuntimeConfig["staticClient"];
  if (clientId !== undefined && clientSecret !== undefined) {
    if (clientId.length === 0 || clientSecret.length === 0) {
      throw new Error("Static client credentials must be non-empty");
    }
    staticClient = {
      clientId,
      clientSecret,
      clientName: environment.SLNCTRZ_CLIENT_NAME ?? "SlncTrZ-MCP",
      redirectUris: parseCsv(environment.SLNCTRZ_CLIENT_REDIRECT_URIS, [
        "https://claude.ai/api/mcp/auth_callback"
      ])
    };
  }

  const defaultAllowedHosts = [publicMcpUrl.hostname, "localhost", "127.0.0.1", "[::1]"].filter(
    (value, index, values) => value.length > 0 && values.indexOf(value) === index
  );
  const allowedHostnames = parseCsv(environment.SLNCTRZ_ALLOWED_HOSTS, defaultAllowedHosts);
  const allowedOriginHostnames = parseCsv(environment.SLNCTRZ_ALLOWED_ORIGINS, allowedHostnames);
  const publicHostname = publicMcpUrl.hostname.toLowerCase();
  if (!allowedHostnames.some((value) => value.toLowerCase() === publicHostname)) {
    throw new Error("SLNCTRZ_ALLOWED_HOSTS must include the public MCP hostname");
  }
  if (
    ownerWebEnabled &&
    !allowedOriginHostnames.some((value) => value.toLowerCase() === publicHostname)
  ) {
    throw new Error(
      "SLNCTRZ_ALLOWED_ORIGINS must include the public MCP hostname when Owner Console is enabled"
    );
  }

  const stateRoot = environment.SLNCTRZ_STATE_ROOT ?? managedStatePaths().root;
  if (!isAbsolute(stateRoot)) {
    throw new Error("SLNCTRZ_STATE_ROOT must be an absolute path");
  }

  const policyFile = environment.SLNCTRZ_POLICY_FILE;
  if (policyFile !== undefined && !isAbsolute(policyFile)) {
    throw new Error("SLNCTRZ_POLICY_FILE must be an absolute path");
  }
  return {
    host,
    port,
    publicMcpUrl,
    ...(ownerSecretHash === undefined || ownerSecretHash.length === 0 ? {} : { ownerSecretHash }),
    maxDynamicClients,
    controlHost,
    controlPort,
    telemetryEnabled,
    ownerWebEnabled,
    allowedHostnames,
    allowedOriginHostnames,
    stateRoot,
    ...(policyFile === undefined ? {} : { policyFile }),
    ...(staticClient === undefined ? {} : { staticClient })
  };
}
