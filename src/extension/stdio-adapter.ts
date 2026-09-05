/**
 * Stdio Extension Adapter — one isolated third-party MCP provider over stdio.
 *
 * Negotiates MCP 2026-07-28 using a disposable server/discover probe and falls back to a
 * fresh 2025-era initialize connection. Every child callback is generation-bound so late
 * events from an older process cannot stop or corrupt a newer provider generation.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import {
  AdapterError,
  type AdapterCallOptions,
  type AdapterHealth,
  type ExtensionAdapter,
  type ExtensionCallResult,
  type ExtensionToolInfo,
  type ProviderCredential
} from "./adapter.js";
import { APP_VERSION } from "../shared/build-info.js";
import { type CompiledExtensionManifest } from "./manifest.js";

const MODERN_PROTOCOL = "2026-07-28";
const LEGACY_PROTOCOL = "2025-11-25";
const CLIENT_INFO = { name: "slnctrz", version: APP_VERSION } as const;

type ProtocolEra = "modern" | "legacy";

interface RpcResponse {
  readonly id?: number | string;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
  readonly jsonrpc: string;
}

interface ListToolsResult {
  readonly tools?: readonly { readonly name?: string; readonly description?: string }[];
}

interface CallToolResult {
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  readonly isError?: boolean;
}

interface DiscoverResult {
  readonly supportedVersions?: readonly string[];
}

type ProviderResult =
  DiscoverResult | ListToolsResult | CallToolResult | { readonly protocolVersion?: unknown };

interface PendingRequest {
  resolve(value: RpcResponse): void;
  reject(error: unknown): void;
}

interface StdioGeneration {
  readonly child: ChildProcess;
  readonly pending: Map<number, PendingRequest>;
  stopped: boolean;
  stdoutCarry: string;
  operationBytes: number;
}

function sanitizedEnv(
  manifest: CompiledExtensionManifest,
  credentials: readonly ProviderCredential[]
): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  for (const key of manifest.envAllowlist) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const credential of credentials) {
    if (credential.kind !== "env") continue;
    if (!manifest.envAllowlist.includes(credential.name)) {
      throw new AdapterError("provider_unavailable", "credential env key is not allowlisted");
    }
    env[credential.name] = credential.value;
  }
  return env;
}

function truncateText(text: string, limit: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return { text, truncated: false };
  return { text: bytes.subarray(0, limit).toString("utf8"), truncated: true };
}

function asResult(response: RpcResponse): ProviderResult {
  if (response.error !== undefined) {
    throw new AdapterError("provider_protocol_error", "provider returned a JSON-RPC error");
  }
  return response.result as ProviderResult;
}

function modernParams(params: Record<string, unknown>): Record<string, unknown> {
  return {
    ...params,
    _meta: {
      "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL,
      "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  };
}

export function createStdioAdapter(
  manifest: CompiledExtensionManifest,
  credentials: readonly ProviderCredential[] = []
): ExtensionAdapter {
  const command = manifest.command;
  if (command === undefined) {
    throw new AdapterError("provider_unavailable", "stdio adapter requires a command");
  }

  let generation: StdioGeneration | undefined;
  let nextId = 1;
  let era: ProtocolEra = "legacy";

  const rejectGeneration = (
    current: StdioGeneration,
    code: AdapterError["code"] = "provider_unavailable"
  ): void => {
    for (const entry of current.pending.values()) {
      entry.reject(new AdapterError(code, code));
    }
    current.pending.clear();
  };

  const stopGeneration = (
    current: StdioGeneration,
    code: AdapterError["code"] = "provider_unavailable"
  ): void => {
    if (current.stopped) return;
    current.stopped = true;
    if (generation === current) generation = undefined;
    rejectGeneration(current, code);
    current.child.stdin?.end();
    current.child.stdout?.removeAllListeners();
    current.child.stderr?.removeAllListeners();
    current.child.stdin?.removeAllListeners();
    current.child.removeAllListeners("error");
    current.child.removeAllListeners("exit");
    if (current.child.exitCode !== null) return;
    current.child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (current.child.exitCode === null) current.child.kill("SIGKILL");
    }, 1_000);
    timer.unref();
  };

  const consumeStdout = (current: StdioGeneration, chunk: Buffer): void => {
    if (current.stopped) return;
    current.operationBytes += chunk.length;
    if (current.operationBytes > manifest.maxOutputBytes) {
      stopGeneration(current);
      return;
    }
    current.stdoutCarry += chunk.toString("utf8");
    if (Buffer.byteLength(current.stdoutCarry, "utf8") > manifest.maxMessageBytes) {
      stopGeneration(current);
      return;
    }
    while (true) {
      const newline = current.stdoutCarry.indexOf("\n");
      if (newline === -1) return;
      const line = current.stdoutCarry.slice(0, newline);
      current.stdoutCarry = current.stdoutCarry.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > manifest.maxMessageBytes) {
        stopGeneration(current);
        return;
      }
      let message: RpcResponse;
      try {
        message = JSON.parse(line) as RpcResponse;
      } catch {
        stopGeneration(current, "provider_protocol_error");
        return;
      }
      if (message.id === undefined) continue;
      const id = Number(message.id);
      const entry = current.pending.get(id);
      if (entry === undefined) continue;
      current.pending.delete(id);
      entry.resolve(message);
    }
  };

  const consumeStderr = (current: StdioGeneration, chunk: Buffer): void => {
    if (current.stopped) return;
    current.operationBytes += chunk.length;
    if (current.operationBytes > manifest.maxOutputBytes) stopGeneration(current);
  };

  const spawnGeneration = (): StdioGeneration => {
    const child = spawn(command, manifest.args, {
      shell: false,
      cwd: dirname(command),
      stdio: ["pipe", "pipe", "pipe"],
      env: sanitizedEnv(manifest, credentials)
    });
    const current: StdioGeneration = {
      child,
      pending: new Map(),
      stopped: false,
      stdoutCarry: "",
      operationBytes: 0
    };
    generation = current;
    child.stdout?.on("data", (chunk: Buffer) => consumeStdout(current, chunk));
    child.stderr?.on("data", (chunk: Buffer) => consumeStderr(current, chunk));
    child.stdout?.on("error", () => stopGeneration(current));
    child.stderr?.on("error", () => stopGeneration(current));
    child.stdin?.on("error", () => stopGeneration(current));
    child.once("error", () => stopGeneration(current));
    child.once("exit", () => stopGeneration(current));
    return current;
  };

  const send = (
    current: StdioGeneration,
    payload: Record<string, unknown>
  ): Promise<RpcResponse> => {
    const stdin = current.child.stdin;
    if (stdin === null || stdin === undefined || current.stopped || generation !== current) {
      return Promise.reject(new AdapterError("provider_unavailable", "provider_unavailable"));
    }
    const id = nextId;
    nextId += 1;
    const line = `${JSON.stringify({ jsonrpc: "2.0", id, ...payload })}\n`;
    if (Buffer.byteLength(line, "utf8") > manifest.maxMessageBytes) {
      return Promise.reject(
        new AdapterError("provider_protocol_error", "request exceeds message cap")
      );
    }
    current.operationBytes = 0;
    return new Promise<RpcResponse>((resolve, reject) => {
      current.pending.set(id, { resolve, reject });
      stdin.write(line, (error) => {
        if (error === undefined || error === null) return;
        current.pending.delete(id);
        reject(new AdapterError("provider_unavailable", "provider_unavailable"));
      });
    });
  };

  const notify = (
    current: StdioGeneration,
    method: string,
    params?: Record<string, unknown>
  ): Promise<void> => {
    const stdin = current.child.stdin;
    if (stdin === null || stdin === undefined || current.stopped || generation !== current) {
      return Promise.reject(new AdapterError("provider_unavailable", "provider_unavailable"));
    }
    const line = `${JSON.stringify({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params })
    })}\n`;
    if (Buffer.byteLength(line, "utf8") > manifest.maxMessageBytes) {
      return Promise.reject(
        new AdapterError("provider_protocol_error", "request exceeds message cap")
      );
    }
    return new Promise<void>((resolve, reject) => {
      stdin.write(line, (error) => {
        if (error === undefined || error === null) resolve();
        else reject(new AdapterError("provider_unavailable", "provider_unavailable"));
      });
    });
  };

  const startLegacy = async (): Promise<void> => {
    const legacy = spawnGeneration();
    try {
      const response = await send(legacy, {
        method: "initialize",
        params: {
          protocolVersion: LEGACY_PROTOCOL,
          capabilities: {},
          clientInfo: CLIENT_INFO
        }
      });
      const initialized = asResult(response) as { readonly protocolVersion?: unknown };
      if (
        typeof initialized.protocolVersion !== "string" ||
        initialized.protocolVersion.length === 0 ||
        initialized.protocolVersion === MODERN_PROTOCOL
      ) {
        throw new AdapterError("provider_protocol_error", "invalid legacy protocol negotiation");
      }
      await notify(legacy, "notifications/initialized");
      era = "legacy";
    } catch (error) {
      stopGeneration(legacy);
      if (error instanceof AdapterError) throw error;
      throw new AdapterError("provider_unavailable", "initialize failed");
    }
  };

  const startModernOrLegacy = async (): Promise<void> => {
    const probe = spawnGeneration();
    let fallback = false;
    try {
      const response = await send(probe, {
        method: "server/discover",
        params: modernParams({})
      });
      if (response.error !== undefined) {
        if (response.error.code === -32601) fallback = true;
        else
          throw new AdapterError("provider_protocol_error", "provider returned a JSON-RPC error");
      } else {
        const discovery = response.result as DiscoverResult | undefined;
        fallback = discovery?.supportedVersions?.includes(MODERN_PROTOCOL) !== true;
      }
      if (!fallback) {
        era = "modern";
        return;
      }
    } catch (error) {
      stopGeneration(probe);
      if (error instanceof AdapterError) throw error;
      throw new AdapterError("provider_unavailable", "provider discovery failed");
    }

    stopGeneration(probe);
    await startLegacy();
  };

  const activeGeneration = (): StdioGeneration => {
    const current = generation;
    if (current === undefined || current.stopped || current.child.exitCode !== null) {
      throw new AdapterError("provider_unavailable", "provider_unavailable");
    }
    return current;
  };

  const requestParams = (params: Record<string, unknown>): Record<string, unknown> =>
    era === "modern" ? modernParams(params) : params;

  return {
    async start(): Promise<void> {
      const existing = generation;
      if (existing !== undefined && !existing.stopped && existing.child.exitCode === null) {
        return;
      }
      await startModernOrLegacy();
    },

    async listTools(): Promise<readonly ExtensionToolInfo[]> {
      const current = activeGeneration();
      const response = await send(current, {
        method: "tools/list",
        params: requestParams({})
      });
      const result = asResult(response) as ListToolsResult;
      return (result.tools ?? [])
        .filter((tool) => tool.name !== undefined)
        .map((tool) => ({
          canonicalId: tool.name ?? "",
          exposedName: tool.name ?? "",
          riskClass: "read" as const,
          ...(tool.description === undefined ? {} : { description: tool.description })
        }));
    },

    async callTool(
      toolId: string,
      args: unknown,
      options: AdapterCallOptions
    ): Promise<ExtensionCallResult> {
      const current = activeGeneration();
      const signal = options.signal;
      if (signal?.aborted === true) {
        stopGeneration(current);
        throw new AdapterError("provider_unavailable", "provider_unavailable");
      }
      const onAbort = (): void => stopGeneration(current);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await send(current, {
          method: "tools/call",
          params: requestParams({ name: toolId, arguments: args })
        });
        const result = asResult(response) as CallToolResult;
        const rendered = (result.content ?? []).map((content) => content.text ?? "").join("\n");
        const bounded = truncateText(rendered, manifest.maxOutputBytes);
        return {
          isError: result.isError === true,
          truncated: bounded.truncated,
          text: bounded.text
        };
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },

    async stop(): Promise<void> {
      const current = generation;
      if (current !== undefined) stopGeneration(current);
    },

    health(): AdapterHealth {
      const current = generation;
      return current !== undefined && !current.stopped && current.child.exitCode === null
        ? "ready"
        : "unavailable";
    }
  };
}
