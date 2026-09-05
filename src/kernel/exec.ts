/** Direct platform-native execution for command.json-authorized commands. */

import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { type KernelExecutionOptions } from "./execution.js";

export const DEFAULT_MAX_EXEC_ARGS = 4_096;
export const HARD_MAX_EXEC_ARGS = 4_096;
export const DEFAULT_MAX_EXEC_OUTPUT_BYTES = 8 * 1_048_576;
export const HARD_EXEC_OUTPUT_CEILING_BYTES = 8 * 1_048_576;
export const DEFAULT_EXEC_TIMEOUT_MS = 30 * 60_000;
export const HARD_EXEC_TIMEOUT_CEILING_MS = 2 * 60 * 60_000;
export const DEFAULT_EXEC_KILL_GRACE_MS = 2_000;
/** Linux MAX_ARG_STRLEN is normally 32 pages = 128 KiB including the trailing NUL. */
export const MAX_EXEC_ARG_BYTES = 128 * 1_024 - 1;
/** Keep a large Linux argv budget while reserving headroom below the common 2 MiB ARG_MAX. */
export const MAX_EXEC_ARGV_BYTES_POSIX = 1_048_576;
/** CreateProcessW is 32,767 UTF-16 code units including the trailing NUL; reserve quoting headroom. */
export const MAX_EXEC_COMMAND_LINE_CHARS_WINDOWS = 30_000;
/** cmd.exe is limited to 8,191 characters; reserve wrapper/quoting headroom for .cmd/.bat. */
export const MAX_EXEC_COMMAND_LINE_CHARS_WINDOWS_CMD = 7_500;

export interface ExecOptions extends KernelExecutionOptions {
  readonly dryRun?: boolean;
  readonly execPath?: string;
  readonly maxOutputBytes?: number;
  readonly spawnAdapter?: SpawnAdapter;
}

export interface SpawnedStream {
  on(event: "data" | "error", listener: (...args: unknown[]) => void): void;
  removeAllListeners(event?: string): void;
}

export interface SpawnedProcess {
  readonly pid: number | undefined;
  readonly stdout: SpawnedStream | null;
  readonly stderr: SpawnedStream | null;
  once(event: "close" | "error", listener: (...args: unknown[]) => void): void;
  kill(signal: string): boolean;
  removeAllListeners(event?: string): void;
}

export interface SpawnOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly stdio: readonly string[];
  readonly detached: boolean;
}

export type SpawnAdapter = (
  binaryPath: string,
  argv: readonly string[],
  options: SpawnOptions
) => SpawnedProcess;

export const defaultSpawnAdapter: SpawnAdapter = (binaryPath, argv, options) => {
  const stdio = [...options.stdio] as ["ignore" | "pipe", "pipe", "pipe"];
  // Windows cannot execute .cmd/.bat files directly through CreateProcess. Route only these
  // trusted catalog-resolved scripts through cmd.exe; arguments are validated before this point.
  if (process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(binaryPath)) {
    const command = [`"${binaryPath}"`, ...argv.map((arg) => `"${arg}"`)].join(" ");
    const verbatimArgs = `/d /v:off /s /c "${command}"`;
    return spawn(process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", [verbatimArgs], {
      cwd: options.cwd,
      env: options.env,
      stdio,
      detached: false,
      windowsHide: true,
      windowsVerbatimArguments: true
    }) as unknown as SpawnedProcess;
  }

  // SAFETY: node:child_process spawn returns a ChildProcess; we narrow it to this module's
  // structural SpawnedProcess. The contract is the stdio shape already validated by the caller.
  return spawn(binaryPath, argv, {
    cwd: options.cwd,
    env: options.env,
    stdio,
    detached: options.detached,
    windowsHide: process.platform === "win32"
  }) as unknown as SpawnedProcess;
};

export interface ExecResult {
  readonly commandId: string;
  readonly commandClass: "execute";
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly envKeys: readonly string[];
  readonly applied: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
}

export type ExecErrorCode =
  | "no_root"
  | "unknown_command"
  | "invalid_args"
  | "invalid_cwd"
  | "invalid_input"
  | "invalid_limit"
  | "permission_denied"
  | "spawn_failed";

export class ExecError extends Error {
  readonly code: ExecErrorCode;
  constructor(code: ExecErrorCode, message: string) {
    super(message);
    this.name = "ExecError";
    this.code = code;
  }
}

export interface RunCommandOptions extends ExecOptions {
  readonly maxArgs?: number;
}

export interface ManagedRunCommandHandle {
  cancel(): void;
  readonly completion: Promise<ExecResult>;
}

function completedRunCommandHandle(result: ExecResult): ManagedRunCommandHandle {
  return Object.freeze({
    cancel: () => undefined,
    completion: Promise.resolve(result)
  });
}

export function validateExecArgvSize(
  binary: string,
  argv: readonly string[],
  platform: NodeJS.Platform = process.platform
): void {
  for (const arg of argv) {
    if (Buffer.byteLength(arg, "utf8") > MAX_EXEC_ARG_BYTES) {
      throw new ExecError("invalid_limit", "Argument exceeds the per-arg byte ceiling");
    }
  }

  if (platform === "win32") {
    const commandLineChars = /\.(?:cmd|bat)$/iu.test(binary)
      ? `/d /v:off /s /c "${[`"${binary}"`, ...argv.map((arg) => `"${arg}"`)].join(" ")}"`.length
      : [binary, ...argv].reduce((total, value) => total + value.length + 3, 0);
    const ceiling = /\.(?:cmd|bat)$/iu.test(binary)
      ? MAX_EXEC_COMMAND_LINE_CHARS_WINDOWS_CMD
      : MAX_EXEC_COMMAND_LINE_CHARS_WINDOWS;
    if (commandLineChars > ceiling) {
      throw new ExecError(
        "invalid_limit",
        "Argument vector exceeds the Windows command-line ceiling"
      );
    }
    return;
  }

  const argvBytes =
    Buffer.byteLength(binary, "utf8") +
    1 +
    argv.reduce((total, arg) => total + Buffer.byteLength(arg, "utf8") + 1, 0);
  if (argvBytes > MAX_EXEC_ARGV_BYTES_POSIX) {
    throw new ExecError("invalid_limit", "Argument vector exceeds the POSIX byte ceiling");
  }
}

export async function startRunCommand(
  binary: string,
  argv: readonly string[],
  runRoot: string,
  options: RunCommandOptions = {}
): Promise<ManagedRunCommandHandle> {
  if (runRoot.length === 0) throw new ExecError("no_root", "No exec root is configured");
  if (argv.some((arg) => arg.includes("\0"))) {
    throw new ExecError("invalid_input", "Argument contains NUL bytes");
  }
  const maxArgs = options.maxArgs ?? DEFAULT_MAX_EXEC_ARGS;
  if (!Number.isSafeInteger(maxArgs) || maxArgs <= 0 || maxArgs > HARD_MAX_EXEC_ARGS) {
    throw new ExecError("invalid_limit", "Argument limit is outside the supported range");
  }
  if (argv.length > maxArgs) {
    throw new ExecError("invalid_limit", "Argument count exceeds the configured ceiling");
  }
  validateExecArgvSize(binary, argv);

  const env: Record<string, string> = {
    PATH:
      options.execPath ?? process.env.PATH ?? (process.platform === "win32" ? "" : "/usr/bin:/bin")
  };
  if (process.platform === "win32") {
    for (const key of [
      "SystemRoot",
      "ComSpec",
      "PATHEXT",
      "TEMP",
      "TMP",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA"
    ]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
  }
  const baseResult = {
    commandId: binary,
    commandClass: "execute" as const,
    argv: [...argv],
    cwd: ".",
    envKeys: Object.keys(env),
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false
  };

  if (options.signal?.aborted === true) {
    return completedRunCommandHandle({
      ...baseResult,
      applied: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: true,
      durationMs: 0
    });
  }
  if (options.dryRun === true) {
    return completedRunCommandHandle({
      ...baseResult,
      applied: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: false,
      durationMs: 0
    });
  }

  let binaryReal: string;
  try {
    binaryReal = await realpath(binary);
    const info = await stat(binaryReal);
    const sameApprovedBinary =
      process.platform === "win32"
        ? binaryReal.toLocaleLowerCase("en-US") === binary.toLocaleLowerCase("en-US")
        : binaryReal === binary;
    if (!info.isFile() || !sameApprovedBinary) {
      throw new ExecError("spawn_failed", "Executable is no longer the approved regular file");
    }
  } catch (error) {
    if (error instanceof ExecError) throw error;
    throw new ExecError("spawn_failed", "Executable could not be revalidated");
  }

  if (process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(binaryReal)) {
    const unsafeCmdMeta = /[\r\n"&|<>^%!()]/u;
    if (argv.some((arg) => unsafeCmdMeta.test(arg))) {
      throw new ExecError(
        "invalid_args",
        "Argument contains characters unsafe for Windows command scripts"
      );
    }
  }

  const startedAt = Date.now();
  const spawnAdapter = options.spawnAdapter ?? defaultSpawnAdapter;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_EXEC_OUTPUT_BYTES;
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes <= 0 ||
    maxOutputBytes > HARD_EXEC_OUTPUT_CEILING_BYTES
  ) {
    throw new ExecError("invalid_limit", "Output limit is outside the supported range");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > HARD_EXEC_TIMEOUT_CEILING_MS
  ) {
    throw new ExecError("invalid_limit", "Timeout is outside the supported range");
  }

  let cancel = (): void => undefined;
  const completion = new Promise<ExecResult>((resolve, reject) => {
    let settled = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const stdoutBuffers: Buffer[] = [];
    const stderrBuffers: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminalCause: "exit" | "timeout" | "abort" | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    const child = spawnAdapter(binaryReal, [...argv], {
      cwd: runRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });

    const onStreamData = (kind: "stdout" | "stderr", chunk: Buffer): void => {
      const buffers = kind === "stdout" ? stdoutBuffers : stderrBuffers;
      const used = kind === "stdout" ? stdoutBytes : stderrBytes;
      if (used >= maxOutputBytes) {
        if (kind === "stdout") stdoutTruncated = true;
        else stderrTruncated = true;
        return;
      }
      const slice = chunk.subarray(0, maxOutputBytes - used);
      buffers.push(slice);
      if (kind === "stdout") {
        stdoutBytes += slice.length;
        if (slice.length < chunk.length) stdoutTruncated = true;
      } else {
        stderrBytes += slice.length;
        if (slice.length < chunk.length) stderrTruncated = true;
      }
    };

    const cleanup = (): void => {
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      options.signal?.removeEventListener("abort", onAbort);
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
    };

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        ...baseResult,
        applied: true,
        exitCode: signal === null ? code : null,
        signal,
        timedOut: terminalCause === "timeout",
        cancelled: terminalCause === "abort",
        stdout: Buffer.concat(stdoutBuffers).toString("utf8"),
        stderr: Buffer.concat(stderrBuffers).toString("utf8"),
        stdoutTruncated,
        stderrTruncated,
        durationMs: Date.now() - startedAt
      });
    };

    const killTree = (signal: NodeJS.Signals): void => {
      if (process.platform === "win32") {
        try {
          if (child.pid !== undefined) {
            spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
              stdio: "ignore",
              windowsHide: true
            }).unref();
            return;
          }
        } catch {
          // Fall through to direct child termination.
        }
        try {
          child.kill(signal);
        } catch {
          return;
        }
        return;
      }

      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          return;
        }
      }
    };

    const terminate = (cause: "timeout" | "abort"): void => {
      if (terminalCause !== undefined) return;
      terminalCause = cause;
      killTree("SIGTERM");
      graceTimer = setTimeout(() => killTree("SIGKILL"), DEFAULT_EXEC_KILL_GRACE_MS);
      graceTimer.unref();
    };
    const onAbort = (): void => terminate("abort");
    cancel = onAbort;
    const timer = setTimeout(() => terminate("timeout"), timeoutMs);
    timer.unref();

    child.once("error", () => {
      if (child.pid === undefined && !settled) {
        settled = true;
        cleanup();
        reject(new ExecError("spawn_failed", "Spawn failed"));
      }
    });
    child.stdout?.on("data", (chunk) => onStreamData("stdout", chunk as Buffer));
    child.stderr?.on("data", (chunk) => onStreamData("stderr", chunk as Buffer));
    child.stdout?.on("error", () => child.stdout?.removeAllListeners());
    child.stderr?.on("error", () => child.stderr?.removeAllListeners());
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("close", (code, signal) => {
      const exitCode = code === null ? null : (code as number);
      const exitSignal = signal === null ? null : (signal as NodeJS.Signals);
      if (terminalCause !== undefined && process.platform !== "win32") {
        // The process-group leader may exit before descendants that ignored SIGTERM. Escalate
        // the group before settling the managed handle so cleanup cannot cancel the grace timer
        // and strand a managed grandchild.
        killTree("SIGKILL");
      }
      finish(
        terminalCause === undefined ? exitCode : null,
        exitSignal ?? (terminalCause === undefined ? null : "SIGTERM")
      );
    });
  });

  return Object.freeze({
    cancel: () => cancel(),
    completion
  });
}

export async function executeRunCommand(
  binary: string,
  argv: readonly string[],
  runRoot: string,
  options: RunCommandOptions = {}
): Promise<ExecResult> {
  const handle = await startRunCommand(binary, argv, runRoot, options);
  return handle.completion;
}
