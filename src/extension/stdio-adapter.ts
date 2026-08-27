/**
 * Stdio Extension Adapter — one isolated third-party MCP provider over stdio.
 * Wing: extension | Topic: stdio-adapter | Updated: 2026-08-27
 *
 * The adapter spawns only the manifest's fixed command and argv with shell disabled, a
 * minimal explicit environment and a fixed command-directory cwd. It drains and bounds
 * both output streams, parses every newline-delimited JSON-RPC frame, and tears the child
 * down on cancellation, protocol failure, output overflow or stop.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import {
  AdapterError,
  type AdapterCallOptions,
  type AdapterHealth,
  type ExtensionAdapter,
  type ExtensionCallResult,
  type ExtensionToolInfo
} from "./adapter.js";
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

function sanitizedEnv(manifest: CompiledExtensionManifest): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  for (const key of manifest.envAllowlist) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function truncateText(text: string, limit: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return { text, truncated: false };
  return { text: bytes.subarray(0, limit).toString("utf8"), truncated: true };
}

function asResult(response: RpcResponse): unknown {
  if (response.error !== undefined) {
    throw new AdapterError("provider_protocol_error", "provider returned a JSON-RPC error");
  }
  return response.result;
}

/**
 * Create a stdio adapter bound to one compiled manifest. No caller-selected executable,
 * args, cwd or environment crosses this boundary.
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
  let operationBytes = 0;
  const pending = new Map<
    number,
    { resolve: (value: RpcResponse) => void; reject: (error: unknown) => void }
  >();

  const rejectAllPending = (code: AdapterError["code"]): void => {
    for (const entry of pending.values()) entry.reject(new AdapterError(code, code));
    pending.clear();
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    const current = child;
    child = undefined;
    rejectAllPending("provider_unavailable");
    if (current === undefined) return;
    current.stdin?.end();
    current.stdout?.removeAllListeners();
    current.stderr?.removeAllListeners();
    current.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      if (current.exitCode === null) current.kill("SIGKILL");
    }, 1_000);
    killTimer.unref();
  };

  const consumeStdout = (chunk: Buffer): void => {
    operationBytes += chunk.length;
    if (operationBytes > manifest.maxOutputBytes) {
      stop();
      return;
    }
    stdoutCarry += chunk.toString("utf8");
    if (Buffer.byteLength(stdoutCarry, "utf8") > manifest.maxMessageBytes) {
      stop();
      return;
    }
    while (true) {
      const newline = stdoutCarry.indexOf("\n");
      if (newline === -1) return;
      const line = stdoutCarry.slice(0, newline);
      stdoutCarry = stdoutCarry.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > manifest.maxMessageBytes) {
        stop();
        return;
      }
      let message: RpcResponse;
      try {
        message = JSON.parse(line) as RpcResponse;
      } catch {
        stop();
        return;
      }
      if (message.id === undefined) continue;
      const id = Number(message.id);
      const pendingEntry = pending.get(id);
      if (pendingEntry === undefined) continue;
      pending.delete(id);
      pendingEntry.resolve(message);
    }
  };

  const consumeStderr = (chunk: Buffer): void => {
    operationBytes += chunk.length;
    if (operationBytes > manifest.maxOutputBytes) stop();
  };

  const send = (payload: Record<string, unknown>): Promise<RpcResponse> => {
    const current = child;
    const stdin = current?.stdin;
    if (stdin === undefined || stdin === null || stopped) {
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
    operationBytes = 0;
    return new Promise<RpcResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      stdin.write(line, (error) => {
        if (error === undefined || error === null) return;
        pending.delete(id);
        reject(new AdapterError("provider_unavailable", "provider_unavailable"));
      });
    });
  };

  return {
    async start(): Promise<void> {
      if (child !== undefined && !stopped) return;
      stopped = false;
      stdoutCarry = "";
      operationBytes = 0;
      const current = spawn(command, manifest.args, {
        shell: false,
        cwd: dirname(command),
        stdio: ["pipe", "pipe", "pipe"],
        env: sanitizedEnv(manifest)
      });
      child = current;
      current.stdout?.on("data", (chunk: Buffer) => consumeStdout(chunk));
      current.stderr?.on("data", (chunk: Buffer) => consumeStderr(chunk));
      current.stdout?.on("error", stop);
      current.stderr?.on("error", stop);
      current.stdin?.on("error", stop);
      current.once("error", stop);
      current.once("exit", stop);
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
        stop();
        throw new AdapterError("provider_unavailable", "initialize failed");
      }
    },

    async listTools(): Promise<readonly ExtensionToolInfo[]> {
      const response = await send({ method: "tools/list", params: {} });
      const result = asResult(response) as ListToolsResult;
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
      const signal = options.signal;
      if (signal?.aborted === true) {
        throw new AdapterError("provider_unavailable", "provider_unavailable");
      }
      const onAbort = (): void => stop();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await send({
          method: "tools/call",
          params: { name: toolId, arguments: args }
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
      stop();
    },

    health(): AdapterHealth {
      const alive = child !== undefined && child.exitCode === null && !stopped;
      return alive ? "ready" : "unavailable";
    }
  };
}
