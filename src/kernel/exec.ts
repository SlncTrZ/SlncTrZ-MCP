/**
 * Direct Process Execution — fixed-definition POSIX-only, bounded, dry-run-first.
 * Wing: kernel | Topic: exec-tool | Updated: 2026-08-27
 *
 * Provenance: PLAN Phase 3, ARCHITECTURE §4.8/§4.10, THREAT_MODEL Execution gate, ADR-017.
 *
 * core.exec runs one operator-authored command definition. The caller selects only a
 * commandId; it never supplies a binary path, a shell string, argv, cwd, or stdin.
 * Phase 3.1 is POSIX-only (Windows is fail-closed with `unsupported_platform`), uses
 * direct `spawn` with `shell: false`, a fixed minimal child environment, and one
 * single-settle state machine (`exit | timeout | abort | spawn_error`).
 */

import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import * as z from "zod/v4";
import { type KernelExecutionOptions } from "./execution.js";

export const DEFAULT_MAX_EXEC_ARGS = 32;
export const DEFAULT_MAX_EXEC_STDIN_BYTES = 1_048_576;
export const DEFAULT_MAX_EXEC_OUTPUT_BYTES = 1_048_576;
export const HARD_EXEC_OUTPUT_CEILING_BYTES = 8 * 1_048_576;
export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
export const DEFAULT_EXEC_KILL_GRACE_MS = 2_000;
export const HARD_EXEC_TIMEOUT_CEILING_MS = 120_000;
export const MAX_EXEC_ARG_BYTES = 512;

export const DENIED_INLINE_EVAL_FLAGS = new Set(["-c", "-e", "-i", "-exec", "--eval"]);

export const DENIED_EXEC_ENV_KEYS = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "PYTHONPATH",
  "PYTHONHOME",
  "RUBYOPT",
  "PERL5OPT",
  "JAVA_TOOL_OPTIONS"
]);

export type ExecCommandClass =
  "inspect" | "metadata_mutation" | "workspace_mutation" | "execute" | "admin";

export interface ExecCommandDefinition {
  readonly commandId: string;
  readonly binaryPath: string;
  readonly fixedArgs: readonly string[];
  readonly allowExtraArgs: boolean;
  readonly allowedExtraArgPattern?: string;
  readonly maxExtraArgs: number;
  readonly cwdMode: "fixed" | "relative";
  readonly fixedEnv: Readonly<Record<string, string>>;
  readonly allowStdin: boolean;
  readonly commandClass: ExecCommandClass;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface ExecOptions extends KernelExecutionOptions {
  readonly dryRun?: boolean;
  readonly execPath?: string;
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

/** Production spawn adapter. A test may inject a fake using {@link ExecOptions.spawnAdapter}. */
export const defaultSpawnAdapter: SpawnAdapter = (binaryPath, argv, options) =>
  // SAFETY: node:child_process.spawn returns a ChildProcess whose pid/on/once/kill/stdout/
  // stderr surface satisfies SpawnedProcess at runtime; this cast is the single boundary to
  // the test seam and does not expose any caller-controlled input to the child environment.
  spawn(binaryPath, argv, {
    cwd: options.cwd,
    env: options.env,
    stdio: [...options.stdio] as ["ignore" | "pipe", "pipe", "pipe"],
    detached: options.detached
  }) as unknown as SpawnedProcess;

const execCommandSchema = z.object({
  commandId: z.string().min(1),
  binaryPath: z.string().min(1),
  fixedArgs: z.array(z.string()),
  allowExtraArgs: z.boolean(),
  allowedExtraArgPattern: z.string().optional(),
  maxExtraArgs: z.number().int().nonnegative(),
  cwdMode: z.enum(["fixed", "relative"]),
  fixedEnv: z.record(z.string(), z.string()),
  allowStdin: z.boolean(),
  commandClass: z.enum(["inspect", "metadata_mutation", "workspace_mutation", "execute", "admin"]),
  timeoutMs: z.number().int().positive().max(HARD_EXEC_TIMEOUT_CEILING_MS).optional(),
  maxOutputBytes: z.number().int().positive().max(HARD_EXEC_OUTPUT_CEILING_BYTES).optional()
});

/** Validate a parsed registry against the full command-definition shape and hard ceilings. */
export function parseExecCommandRegistry(raw: unknown): readonly ExecCommandDefinition[] {
  if (!Array.isArray(raw)) {
    throw new ExecError("invalid_input", "Exec command registry must be an array");
  }
  return raw.map((item, index) => {
    const result = execCommandSchema.safeParse(item);
    if (!result.success) {
      throw new ExecError(
        "invalid_input",
        `Registry entry ${index} is malformed: ${result.error.issues[0]?.message ?? "unknown"}`
      );
    }
    return result.data as ExecCommandDefinition;
  });
}

export interface ExecResult {
  readonly commandId: string;
  readonly commandClass: ExecCommandClass;
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
  | "spawn_failed"
  | "unsupported_platform";

export class ExecError extends Error {
  readonly code: ExecErrorCode;

  constructor(code: ExecErrorCode, message: string) {
    super(message);
    this.name = "ExecError";
    this.code = code;
  }
}

function isContained(candidateRealContainer: string, containerReal: string): boolean {
  return (
    candidateRealContainer.length > 0 &&
    (candidateRealContainer === containerReal ||
      candidateRealContainer.startsWith(containerReal + "/"))
  );
}

function isValidEnvKey(key: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/u.test(key);
}

/** Validate one registry definition against the Phase 3.1 fixed baseline. */
export function assertPhase31Definition(command: ExecCommandDefinition, index: number): void {
  if (command.allowExtraArgs === true) {
    throw new ExecError(
      "invalid_input",
      `command ${command.commandId || index} enables caller arguments`
    );
  }
  if (command.allowStdin === true) {
    throw new ExecError(
      "invalid_input",
      `command ${command.commandId || index} enables caller stdin`
    );
  }
  if (command.cwdMode !== "fixed") {
    throw new ExecError(
      "invalid_input",
      `command ${command.commandId || index} uses non-fixed cwd`
    );
  }
}

/** Canonicalize {@link execRoot} and validate every {@link commands} entry. */
export async function validateExecCommandRegistry(
  execRoot: string,
  rawCommands: readonly ExecCommandDefinition[]
): Promise<{ readonly execRootReal: string; readonly commands: readonly ExecCommandDefinition[] }> {
  let execRootReal: string;
  try {
    execRootReal = await realpath(execRoot);
    const info = await stat(execRootReal);
    if (!info.isDirectory()) {
      throw new ExecError("invalid_input", "Exec root is not a directory");
    }
  } catch (error) {
    if (error instanceof ExecError) throw error;
    throw new ExecError("invalid_input", "Exec root does not exist");
  }

  const seen = new Set<string>();
  const commands: ExecCommandDefinition[] = [];
  for (let i = 0; i < rawCommands.length; i += 1) {
    const raw = rawCommands[i];
    if (raw === undefined) continue;
    if (typeof raw.commandId !== "string" || raw.commandId.length === 0) {
      throw new ExecError("invalid_input", `Registry entry ${i} is missing a commandId`);
    }
    if (seen.has(raw.commandId)) {
      throw new ExecError("invalid_input", `Duplicate commandId: ${raw.commandId}`);
    }
    seen.add(raw.commandId);
    assertPhase31Definition(raw, i);

    if (typeof raw.binaryPath !== "string" || !isAbsolute(raw.binaryPath)) {
      throw new ExecError("invalid_input", `command ${raw.commandId} binaryPath must be absolute`);
    }
    let binaryReal: string;
    try {
      binaryReal = await realpath(raw.binaryPath);
      const info = await stat(binaryReal);
      if (!info.isFile()) {
        throw new ExecError(
          "invalid_input",
          `command ${raw.commandId} binary is not a regular file`
        );
      }
    } catch (error) {
      if (error instanceof ExecError) throw error;
      throw new ExecError("invalid_input", `command ${raw.commandId} binary does not exist`);
    }
    if (!isContained(binaryReal, execRootReal)) {
      throw new ExecError("invalid_input", `command ${raw.commandId} binary escapes exec root`);
    }

    if (!Number.isSafeInteger(raw.maxExtraArgs) || raw.maxExtraArgs < 0) {
      throw new ExecError("invalid_limit", `command ${raw.commandId} maxExtraArgs is invalid`);
    }
    if (raw.maxExtraArgs > DEFAULT_MAX_EXEC_ARGS) {
      throw new ExecError(
        "invalid_limit",
        `command ${raw.commandId} maxExtraArgs exceeds the hard ceiling`
      );
    }

    if (raw.fixedArgs.some((arg) => DENIED_INLINE_EVAL_FLAGS.has(arg))) {
      throw new ExecError(
        "invalid_input",
        `command ${raw.commandId} fixedArgs admit inline evaluation`
      );
    }

    if (raw.cwdMode !== "fixed") {
      throw new ExecError("invalid_input", `command ${raw.commandId} requires relative cwd`);
    }

    for (const key of Object.keys(raw.fixedEnv)) {
      if (!isValidEnvKey(key)) {
        throw new ExecError(
          "invalid_input",
          `command ${raw.commandId} env key "${key}" is invalid`
        );
      }
      if (key === "PATH") {
        throw new ExecError("invalid_input", `command ${raw.commandId} cannot override PATH`);
      }
      if (DENIED_EXEC_ENV_KEYS.has(key.toUpperCase())) {
        throw new ExecError("invalid_input", `command ${raw.commandId} env key "${key}" is denied`);
      }
    }

    if (raw.timeoutMs !== undefined) {
      if (
        !Number.isSafeInteger(raw.timeoutMs) ||
        raw.timeoutMs <= 0 ||
        raw.timeoutMs > HARD_EXEC_TIMEOUT_CEILING_MS
      ) {
        throw new ExecError("invalid_limit", `command ${raw.commandId} timeoutMs is out of range`);
      }
    }
    if (raw.maxOutputBytes !== undefined) {
      if (
        !Number.isSafeInteger(raw.maxOutputBytes) ||
        raw.maxOutputBytes <= 0 ||
        raw.maxOutputBytes > HARD_EXEC_OUTPUT_CEILING_BYTES
      ) {
        throw new ExecError(
          "invalid_limit",
          `command ${raw.commandId} maxOutputBytes exceeds the hard ceiling`
        );
      }
    }

    commands.push(
      Object.freeze({
        ...raw,
        binaryPath: binaryReal,
        fixedArgs: Object.freeze([...raw.fixedArgs]),
        fixedEnv: Object.freeze({ ...raw.fixedEnv }),
        ...(raw.allowedExtraArgPattern === undefined
          ? {}
          : { allowedExtraArgPattern: raw.allowedExtraArgPattern })
      })
    );
  }

  return { execRootReal, commands: Object.freeze(commands) };
}

function envKeys(env: Readonly<Record<string, string>>): readonly string[] {
  return Object.keys(env);
}

/**
 * Execute one already-selected, already-authorized command definition.
 * Throws {@link ExecError} only for launch-prevention failures; timeout and
 * cancellation resolve as {@link ExecResult} outcomes.
 */
export async function executeContainedCommand(
  execRoot: string | undefined,
  command: ExecCommandDefinition,
  args: readonly string[],
  cwdRelPath: string | undefined,
  stdin: string | undefined,
  options: ExecOptions = {}
): Promise<ExecResult> {
  if (process.platform === "win32") {
    throw new ExecError("unsupported_platform", "core.exec is not supported on this platform");
  }
  if (execRoot === undefined || execRoot.length === 0) {
    throw new ExecError("no_root", "No exec root is configured");
  }

  if (Array.isArray(args) && args.length > 0) {
    throw new ExecError("invalid_args", "This command does not accept extra arguments");
  }
  if (cwdRelPath !== undefined) {
    throw new ExecError("invalid_cwd", "This command uses a fixed working directory");
  }
  if (stdin !== undefined && stdin.length > 0) {
    throw new ExecError("invalid_input", "This command does not accept stdin");
  }

  const execPath = options.execPath ?? "";
  const env: Record<string, string> = { PATH: execPath, ...command.fixedEnv };
  const argv = [...command.fixedArgs];
  const baseResult = {
    commandId: command.commandId,
    commandClass: command.commandClass,
    argv,
    cwd: ".",
    envKeys: envKeys(env),
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false
  };

  // Pre-spawn cancellation is a normal outcome, whether or not the request is a dry-run.
  if (options.signal?.aborted === true) {
    return {
      ...baseResult,
      applied: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: true,
      durationMs: 0
    };
  }

  if (options.dryRun !== false) {
    return {
      ...baseResult,
      applied: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: false,
      durationMs: 0
    };
  }

  // Baseline C — revalidate the binary immediately before spawn.
  let binaryReal: string;
  try {
    binaryReal = await realpath(command.binaryPath);
    const info = await stat(binaryReal);
    if (!info.isFile() || binaryReal !== command.binaryPath) {
      throw new ExecError("spawn_failed", "Executable is no longer the approved regular file");
    }
  } catch (error) {
    if (error instanceof ExecError) throw error;
    throw new ExecError("spawn_failed", "Executable could not be revalidated");
  }

  const startedAt = Date.now();
  const spawnAdapter = options.spawnAdapter ?? defaultSpawnAdapter;
  const maxOutputBytes = command.maxOutputBytes ?? DEFAULT_MAX_EXEC_OUTPUT_BYTES;
  if (maxOutputBytes > HARD_EXEC_OUTPUT_CEILING_BYTES) {
    throw new ExecError("invalid_limit", "maxOutputBytes exceeds the hard ceiling");
  }
  const timeoutMs = command.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;

  return new Promise<ExecResult>((resolve, reject) => {
    let settled = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const stdoutBuffers: Buffer[] = [];
    const stderrBuffers: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminalCause: "exit" | "timeout" | "abort" | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    const child = spawnAdapter(binaryReal, argv, {
      cwd: execRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    });

    const onStreamData = (kind: "stdout" | "stderr", chunk: Buffer): void => {
      if (kind === "stdout") {
        if (stdoutBytes < maxOutputBytes) {
          const room = maxOutputBytes - stdoutBytes;
          const slice = chunk.subarray(0, room);
          stdoutBuffers.push(slice);
          stdoutBytes += slice.length;
          if (slice.length < chunk.length) stdoutTruncated = true;
        } else {
          stdoutTruncated = true;
        }
      } else {
        if (stderrBytes < maxOutputBytes) {
          const room = maxOutputBytes - stderrBytes;
          const slice = chunk.subarray(0, room);
          stderrBuffers.push(slice);
          stderrBytes += slice.length;
          if (slice.length < chunk.length) stderrTruncated = true;
        } else {
          stderrTruncated = true;
        }
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
      const stdout = Buffer.concat(stdoutBuffers).toString("utf8");
      const stderr = Buffer.concat(stderrBuffers).toString("utf8");
      resolve({
        commandId: command.commandId,
        commandClass: command.commandClass,
        argv,
        cwd: ".",
        envKeys: envKeys(env),
        applied: true,
        exitCode: signal === null ? code : null,
        signal,
        timedOut: terminalCause === "timeout",
        cancelled: terminalCause === "abort",
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        durationMs: Date.now() - startedAt
      });
    };

    const killTree = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) {
          process.kill(-child.pid, signal);
        }
      } catch {
        try {
          child.kill(signal);
        } catch {
          return;
        }
      }
    };

    const onTimeout = (): void => {
      if (terminalCause !== undefined) return;
      terminalCause = "timeout";
      killTree("SIGTERM");
      graceTimer = setTimeout(() => killTree("SIGKILL"), DEFAULT_EXEC_KILL_GRACE_MS);
      graceTimer.unref();
    };

    const onAbort = (): void => {
      if (terminalCause !== undefined) return;
      terminalCause = "abort";
      killTree("SIGTERM");
      graceTimer = setTimeout(() => killTree("SIGKILL"), DEFAULT_EXEC_KILL_GRACE_MS);
      graceTimer.unref();
    };

    child.once("error", (error) => {
      if (child.pid === undefined) {
        settled = true;
        cleanup();
        reject(new ExecError("spawn_failed", "Spawn failed"));
      }
      void error;
    });

    const timer = setTimeout(() => onTimeout(), timeoutMs);
    timer.unref();

    child.stdout?.on("data", (chunk) => onStreamData("stdout", chunk as Buffer));
    child.stderr?.on("data", (chunk) => onStreamData("stderr", chunk as Buffer));
    child.stdout?.on("error", () => {
      // A broken output pipe must not stall settlement: stop accumulating and let the
      // child 'close' (which always fires) resolve the state machine exactly once.
      child.stdout?.removeAllListeners();
    });
    child.stderr?.on("error", () => {
      child.stderr?.removeAllListeners();
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.once("close", (code, signal) => {
      const exitCode = code === null ? null : (code as number);
      const exitSignal = signal === null ? null : (signal as NodeJS.Signals);
      if (terminalCause === undefined) finish(exitCode, exitSignal);
      else
        finish(
          null,
          exitSignal ??
            (terminalCause === "timeout" || terminalCause === "abort" ? "SIGTERM" : null)
        );
    });
  });
}
