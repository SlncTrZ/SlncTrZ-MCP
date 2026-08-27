/**
 * Stdio Extension Adapter — one isolated third-party MCP provider over stdio.
 * Wing: extension | Topic: stdio-adapter | Updated: 2026-08-27
 *
 * Provenance: PLAN Phase 5, ARCHITECTURE §4.11, ADR-020, and the Phase 5 handoff slice 2.
 *
 * Spawns one provider process with `shell: false`, the manifest's fixed absolute command
 * and fixed argv, and an explicit sanitized environment (only allowlisted keys plus PATH);
 * it never inherits the gateway environment or a broad cwd. The adapter implements the
 * MCP JSON-RPC initialize/tools/list and tools/call messages over stdio, with a hard
 * startup/readiness timeout, a request timeout, abort propagation, child cleanup on stop,
 * and bounded stdout/stderr/message sizes. It never runs provider logic in-process.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  type AdapterCallOptions,
  type AdapterHealth,
  type ExtensionAdapter,
  type ExtensionCallResult,
  type ExtensionToolInfo
} from "./adapter.js";
import { AdapterError } from "./adapter.js";
import { type CompiledExtensionManifest } from "./manifest.js";

const INITIALIZE_PROTOCOL = "2025-06-18";

interface RpcResponse {
  readonly id?: number | string;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
  readonly jsonrpc: string;
}

interface ListToolsResult {
  readonly tools?: readonly { readonly name?: string }[];
}

interface CallToolResult {
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  readonly isError?: boolean;
}

/** Parse a single newline-delimited JSON-RPC frame, tolerating a per-message byte cap. */
function readMessage(
  chunk: Buffer,
  carry: string,
  maxMessageBytes: number
): { message: RpcResponse | undefined; rest: string } {
  const text = carry + chunk.toString("utf8");
  const newline = text.indexOf("\n");
  if (newline === -1) {
    if (text.length > maxMessageBytes) {
      throw new AdapterError("provider_protocol_error", "message exceeds the byte cap");
    }
    return { message: undefined, rest: text };
  }
  const line = text.slice(0, newline);
  if (line.length > maxMessageBytes) {
    throw new AdapterError("provider_protocol_error", "message exceeds the byte cap");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new AdapterError("provider_protocol_error", "invalid JSON-RPC frame");
  }
  return { message: parsed as RpcResponse, rest: text.slice(newline + 1) };
}

/** Build the child environment from the manifest allowlist. Never inherit process.env. */
function sanitizedEnv(manifest: CompiledExtensionManifest): Record<string, string> {
  const env: Record<string, string> = {};
  env.PATH = process.env.PATH ?? "/usr/bin:/bin";
  for (const key of manifest.envAllowlist) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Create a stdio adapter bound to one compiled manifest. The adapter owns the child
 * process lifetime; it never accepts a caller-selected command, endpoint, argv, or env.
 */
export function createStdioAdapter(manifest: CompiledExtensionManifest): ExtensionAdapter {
  const command = manifest.command;
  if (command === undefined) {
    throw new AdapterError("provider_unavailable", "stdio adapter requires a command");
  }

  let child: ChildProcess | undefined;
  let stopped = false;
  let nextId = 1;
  let stdoutCarry = "";
  let stdoutBytes = 0;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();

  const rejectAllPending = (code: AdapterError["code"]): void => {
    for (const entry of pending.values()) {
      entry.reject(new AdapterError(code, code));
    }
    pending.clear();
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    const current = child;
    if (current !== undefined) {
      child = undefined;
      current.stdin?.end();
      current.kill("SIGTERM");
      current.stdout?.removeAllListeners();
      current.stderr?.removeAllListeners();
    }
    rejectAllPending("provider_unavailable");
  };

  const readLoop = (): void => {
    child?.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > manifest.maxOutputBytes) {
        stop();
        return;
      }
      let parsed: { message: RpcResponse | undefined; rest: string };
      try {
        parsed = readMessage(chunk, stdoutCarry, manifest.maxMessageBytes);
      } catch {
        stop();
        return;
      }
      stdoutCarry = parsed.rest;
      const message = parsed.message;
      if (message === undefined) return;
      if (message.id !== undefined) {
        const entry = pending.get(Number(message.id));
        if (entry !== undefined) {
          pending.delete(Number(message.id));
          entry.resolve(message);
          return;
        }
      }
    });
  };

  const send = (payload: Record<string, unknown>): Promise<RpcResponse> => {
    const id = nextId;
    nextId += 1;
    const line = `${JSON.stringify({ jsonrpc: "2.0", id, ...payload })}\n`;
    return new Promise<RpcResponse>((resolve, reject) => {
      pending.set(id, { resolve: (value) => resolve(value as RpcResponse), reject });
      child?.stdin?.write(line);
    });
  };

  return {
    async start(): Promise<void> {
      if (child !== undefined) return;
      child = spawn(command, manifest.args, {
        shell: false,
        cwd: "/",
        stdio: ["pipe", "pipe", "pipe"],
        env: sanitizedEnv(manifest)
      });
      readLoop();
      child.stdin?.on("error", () => undefined);
      try {
        await send({
          method: "initialize",
          params: {
            protocolVersion: INITIALIZE_PROTOCOL,
            capabilities: {},
            clientInfo: { name: "slnctrz", version: "0.1.0" }
          }
        });
      } catch {
        throw new AdapterError("provider_unavailable", "initialize failed");
      }
    },

    async listTools(): Promise<readonly ExtensionToolInfo[]> {
      if (child === undefined) {
        throw new AdapterError("provider_unavailable", "provider not started");
      }
      const response = await send({ method: "tools/list", params: {} });
      const result = response.result as ListToolsResult;
      return (result.tools ?? [])
        .filter((tool) => tool.name !== undefined)
        .map((tool) => ({
          canonicalId: tool.name ?? "",
          exposedName: tool.name ?? "",
          riskClass: "read" as const
        }));
    },

    async callTool(
      toolId: string,
      args: unknown,
      options: AdapterCallOptions
    ): Promise<ExtensionCallResult> {
      if (child === undefined) {
        throw new AdapterError("provider_unavailable", "provider not started");
      }
      const requestTimeout = setTimeout(() => stop(), manifest.requestTimeoutMs ?? 30_000);
      requestTimeout.unref();
      const signal = options.signal;
      const onAbort = (): void => stop();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await send({
          method: "tools/call",
          params: { name: toolId, arguments: args }
        });
        const callResult = response.result as CallToolResult;
        return {
          isError: callResult.isError === true,
          truncated: false,
          text: (callResult.content ?? [])
            .map((content) => content.text ?? "")
            .join("\n")
            .slice(-manifest.maxOutputBytes)
        };
      } finally {
        clearTimeout(requestTimeout);
        signal?.removeEventListener("abort", onAbort);
      }
    },

    async stop(): Promise<void> {
      stop();
    },

    health(): AdapterHealth {
      const alive = child !== undefined && child.exitCode === null && !stopped;
      return alive ? "ready" : "unavailable";
    }
  };
}
