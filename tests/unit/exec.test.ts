import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_EXEC_OUTPUT_BYTES,
  DEFAULT_EXEC_TIMEOUT_MS,
  HARD_EXEC_OUTPUT_CEILING_BYTES,
  executeContainedCommand,
  parseExecCommandRegistry,
  validateExecCommandRegistry,
  type ExecCommandDefinition,
  type ExecError,
  type ExecOptions,
  type SpawnAdapter,
  type SpawnedProcess,
  type SpawnedStream
} from "../../src/kernel/exec.js";

const cleanup: string[] = [];

async function makeExecRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "slnctrz-exec-"));
  cleanup.push(root);
  return root;
}

async function makeScript(root: string, name: string, body: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

function command(
  execRoot: string,
  overrides: Partial<ExecCommandDefinition> = {}
): ExecCommandDefinition {
  return {
    commandId: "test-command",
    binaryPath: join(execRoot, "tool.sh"),
    fixedArgs: [],
    allowExtraArgs: false,
    maxExtraArgs: 0,
    cwdMode: "fixed",
    fixedEnv: {},
    allowStdin: false,
    commandClass: "inspect",
    ...overrides
  };
}

function firstCommand(validated: {
  commands: readonly ExecCommandDefinition[];
}): ExecCommandDefinition {
  const def = validated.commands[0];
  if (def === undefined) throw new Error("No command returned by registry");
  return def;
}

async function run(
  execRoot: string,
  def: ExecCommandDefinition,
  options: ExecOptions = {}
): Promise<ReturnType<typeof executeContainedCommand>> {
  const validated = await validateExecCommandRegistry(execRoot, [def]);
  return executeContainedCommand(
    validated.execRootReal,
    firstCommand(validated),
    [],
    undefined,
    undefined,
    { execPath: "/usr/bin:/bin", ...options }
  );
}

afterEach(async () => {
  for (const path of cleanup.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === "win32")("core.exec (POSIX direct fixed-command)", () => {
  it("defaults to dry-run and never spawns", async () => {
    const root = await makeExecRoot();
    await makeScript(root, "tool.sh", "echo hello");
    const result = await run(root, command(root));
    expect(result.applied).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.envKeys).toContain("PATH");
  });

  it("runs a fixed command and captures stdout and exit code", async () => {
    const root = await makeExecRoot();
    await makeScript(root, "tool.sh", 'echo "hello world"');
    const result = await run(root, command(root), { dryRun: false });
    expect(result.applied).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(result.stdout.trim()).toBe("hello world");
  });

  it("prepends fixedArgs regardless of any caller arg", async () => {
    const root = await makeExecRoot();
    await makeScript(root, "tool.sh", "");
    const def = command(root, { fixedArgs: ["alpha", "beta"] });
    const result = await run(root, def);
    expect(result.argv).toEqual(["alpha", "beta"]);
  });

  it("resolves a non-zero exit code as a result, never a throw", async () => {
    const root = await makeExecRoot();
    await makeScript(root, "tool.sh", "exit 7");
    const result = await run(root, command(root), { dryRun: false });
    expect(result.applied).toBe(true);
    expect(result.exitCode).toBe(7);
  });

  it("builds a closed minimal environment without leaking the gateway env", async () => {
    const root = await makeExecRoot();
    await makeScript(root, "tool.sh", 'echo "path=[$PATH] leak=[$GATEWAY_ONLY_SECRET]"');
    const saved = process.env.GATEWAY_ONLY_SECRET;
    process.env.GATEWAY_ONLY_SECRET = "should-not-leak";
    try {
      const result = await run(root, command(root), { dryRun: false });
      expect(result.stdout).toContain("path=[/usr/bin:/bin]");
      expect(result.stdout).toContain("leak=[]");
      expect(result.stdout).not.toContain("should-not-leak");
    } finally {
      if (saved === undefined) delete process.env.GATEWAY_ONLY_SECRET;
      else process.env.GATEWAY_ONLY_SECRET = saved;
    }
  });

  it("honours fixedEnv values for the child", async () => {
    const root = await makeExecRoot();
    await makeScript(root, "tool.sh", 'echo "mode=[$MY_MODE]"');
    const result = await run(root, command(root, { fixedEnv: { MY_MODE: "on" } }), {
      dryRun: false
    });
    expect(result.stdout).toContain("mode=[on]");
  });

  it("rejects caller arguments, cwd, and stdin", async () => {
    const root = await makeExecRoot();
    await makeScript(root, "tool.sh", "");
    const validated = await validateExecCommandRegistry(root, [command(root)]);
    const def = firstCommand(validated);
    const execRoot = validated.execRootReal;

    await expect(
      executeContainedCommand(execRoot, def, ["extra"], undefined, undefined, {})
    ).rejects.toMatchObject({ code: "invalid_args" } satisfies Partial<ExecError>);
    await expect(
      executeContainedCommand(execRoot, def, [], "subdir", undefined, {})
    ).rejects.toMatchObject({ code: "invalid_cwd" } satisfies Partial<ExecError>);
    await expect(
      executeContainedCommand(execRoot, def, [], undefined, "stdin", {})
    ).rejects.toMatchObject({ code: "invalid_input" } satisfies Partial<ExecError>);
  });

  it("fails closed without an exec root", async () => {
    await expect(
      executeContainedCommand(undefined, command("/tmp/nonexistent"), [], undefined, undefined, {})
    ).rejects.toMatchObject({ code: "no_root" } satisfies Partial<ExecError>);
  });

  it("times out a long-running process and kills the process group", async () => {
    const root = await makeExecRoot();
    await makeScript(root, "tool.sh", "sleep 30");
    const result = await run(root, command(root, { timeoutMs: 800 }), { dryRun: false });
    expect(result.applied).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBe(false);
  }, 10_000);

  it("resolves (not throws) an aborted-before-spawn request", async () => {
    const root = await makeExecRoot();
    await makeScript(root, "tool.sh", "echo hi");
    const controller = new AbortController();
    controller.abort();
    const result = await run(root, command(root), { signal: controller.signal, dryRun: false });
    expect(result.applied).toBe(false);
    expect(result.cancelled).toBe(true);
  });

  it("truncates output beyond the byte cap and reports the flag", async () => {
    const root = await makeExecRoot();
    await makeScript(root, "tool.sh", 'echo "1234567890" && echo "1234567890"');
    const result = await run(root, command(root, { maxOutputBytes: 5 }), { dryRun: false });
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(6);
  });

  it("serializes a definition whose binary is no longer the approved file", async () => {
    const root = await makeExecRoot();
    await makeScript(root, "tool.sh", "echo ok");
    const validated = await validateExecCommandRegistry(root, [command(root)]);
    const def = firstCommand(validated);
    // Swap the approved binary for a symlink to an executable outside execRoot.
    const outside = await makeExecRoot();
    await makeScript(outside, "evil.sh", "echo changed");
    await rm(join(root, "tool.sh"));
    await symlink(join(outside, "evil.sh"), join(root, "tool.sh"));
    await expect(
      executeContainedCommand(validated.execRootReal, def, [], undefined, undefined, {
        dryRun: false
      })
    ).rejects.toMatchObject({ code: "spawn_failed" } satisfies Partial<ExecError>);
  });

  it("kills the entire process group on timeout, including a descendant", async () => {
    const root = await makeExecRoot();
    const childPidFile = join(root, "child.pid");
    await makeScript(root, "tool.sh", `sleep 30 &\necho $! > "${childPidFile}"\nwait`);
    const result = await run(root, command(root, { timeoutMs: 700 }), { dryRun: false });
    expect(result.timedOut).toBe(true);
    expect(result.applied).toBe(true);
    const childPid = Number((await readFile(childPidFile, "utf8")).trim());
    expect(Number.isInteger(childPid)).toBe(true);
    let alive = true;
    for (let i = 0; i < 100 && alive; i += 1) {
      try {
        process.kill(childPid, 0);
      } catch {
        alive = false;
      }
      if (alive) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(alive).toBe(false);
  }, 15_000);

  it("kills the process tree on a mid-execution abort and resolves, not throws", async () => {
    const root = await makeExecRoot();
    await makeScript(root, "tool.sh", "sleep 30");
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 500);
    const result = await run(root, command(root), { dryRun: false, signal: controller.signal });
    clearTimeout(abortTimer);
    expect(result.applied).toBe(true);
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
  }, 15_000);
});

describe.runIf(process.platform === "win32")("core.exec (Windows fail-closed)", () => {
  it("returns unsupported_platform without spawning", async () => {
    const root = await makeExecRoot();
    await makeScript(root, "tool.sh", "echo hi");
    await expect(
      executeContainedCommand(root, command(root), [], undefined, undefined, { dryRun: false })
    ).rejects.toMatchObject({ code: "unsupported_platform" } satisfies Partial<ExecError>);
  });
});

class FakeStream implements SpawnedStream {
  private listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  on(event: "data" | "error", listener: (...args: unknown[]) => void): void {
    (this.listeners[event] ??= []).push(listener as (thing: unknown) => void);
  }
  removeAllListeners(): void {
    this.listeners = {};
  }
  emit(event: "data" | "error", ...args: unknown[]): void {
    for (const listener of this.listeners[event] ?? []) {
      (listener as (...a: unknown[]) => void)(...args);
    }
  }
}

class FakeChild implements SpawnedProcess {
  readonly pid: number | undefined = 42_000;
  readonly stdout: FakeStream = new FakeStream();
  readonly stderr: FakeStream = new FakeStream();
  readonly killCalls: string[] = [];
  private events: Record<string, ((...args: unknown[]) => void)[]> = {};
  once(event: "close" | "error", listener: (...args: unknown[]) => void): void {
    (this.events[event] ??= []).push(listener as (thing: unknown) => void);
  }
  removeAllListeners(): void {
    this.events = {};
  }
  emit(event: "close" | "error", ...args: unknown[]): void {
    for (const listener of this.events[event] ?? []) {
      (listener as (...a: unknown[]) => void)(...args);
    }
  }
  kill(signal: string): boolean {
    this.killCalls.push(signal);
    return true;
  }
}

function fakeDual(overrides: { aborted?: boolean } = {}): {
  adapter: SpawnAdapter;
  child: FakeChild;
  controller: AbortController;
  waitSpawned: () => Promise<void>;
} {
  const child = new FakeChild();
  const controller = new AbortController();
  if (overrides.aborted === true) controller.abort();
  let spawned = false;
  const adapter: SpawnAdapter = () => {
    spawned = true;
    return child;
  };
  const waitSpawned = async (): Promise<void> => {
    while (!spawned) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return { adapter, child, controller, waitSpawned };
}

describe.skipIf(process.platform === "win32")("core.exec state machine (fake spawn)", () => {
  async function fakeRun(
    options: ExecOptions
  ): Promise<ReturnType<typeof executeContainedCommand>> {
    const root = await makeExecRoot();
    await makeScript(root, "tool.sh", "");
    const validated = await validateExecCommandRegistry(root, [command(root)]);
    return executeContainedCommand(
      validated.execRootReal,
      firstCommand(validated),
      [],
      undefined,
      undefined,
      {
        execPath: "/usr/bin:/bin",
        ...options
      }
    );
  }

  it("settles exactly once when stdout errors then closes", async () => {
    const { adapter, child, waitSpawned } = fakeDual();
    const pending = fakeRun({ dryRun: false, spawnAdapter: adapter });
    await waitSpawned();
    child.stdout.emit("data", Buffer.from("hello"));
    child.stdout.emit("error", new Error("EPIPE"));
    child.stderr.emit("error", new Error("EPIPE"));
    child.emit("close", 0, null);
    const result = await pending;
    expect(result.applied).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(child.killCalls).toEqual([]);
  });

  it("resolves (not throws) a post-launch child error then close", async () => {
    const { adapter, child, waitSpawned } = fakeDual();
    const pending = fakeRun({ dryRun: false, spawnAdapter: adapter });
    await waitSpawned();
    child.emit("error", new Error("runtime"));
    child.emit("close", null, "SIGKILL");
    const result = await pending;
    expect(result.applied).toBe(true);
    expect(result.signal).toBe("SIGKILL");
  });

  it("clears the grace timer on abort-close so no SIGKILL follows", async () => {
    const { adapter, child, controller, waitSpawned } = fakeDual();
    const pending = fakeRun({
      dryRun: false,
      spawnAdapter: adapter,
      signal: controller.signal
    });
    await waitSpawned();
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(child.killCalls).toContain("SIGTERM");
    child.emit("close", null, "SIGTERM");
    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    // Wait longer than the kill grace (2s) and assert no late SIGKILL leaked.
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    expect(child.killCalls).not.toContain("SIGKILL");
  }, 10_000);
});

describe("core.exec registry validation", () => {
  it("rejects duplicate commandId", async () => {
    const root = await makeExecRoot();
    await makeScript(root, "tool.sh", "");
    const a = command(root);
    const b = command(root);
    await expect(validateExecCommandRegistry(root, [a, b])).rejects.toMatchObject({
      code: "invalid_input"
    } satisfies Partial<ExecError>);
  });

  it("rejects a binary outside execRoot", async () => {
    const root = await makeExecRoot();
    const outside = await makeExecRoot();
    await makeScript(outside, "tool.sh", "");
    await expect(
      validateExecCommandRegistry(root, [
        { ...command(root), binaryPath: join(outside, "tool.sh") }
      ])
    ).rejects.toMatchObject({ code: "invalid_input" } satisfies Partial<ExecError>);
  });

  it("rejects forbidden environment keys and PATH override", async () => {
    const root = await makeExecRoot();
    await makeScript(root, "tool.sh", "");
    await expect(
      validateExecCommandRegistry(root, [{ ...command(root), fixedEnv: { LD_PRELOAD: "evil" } }])
    ).rejects.toMatchObject({ code: "invalid_input" } satisfies Partial<ExecError>);
    await expect(
      validateExecCommandRegistry(root, [{ ...command(root), fixedEnv: { PATH: "evil" } }])
    ).rejects.toMatchObject({ code: "invalid_input" } satisfies Partial<ExecError>);
  });

  it("rejects fixedArgs admitting an inline-evaluation flag", async () => {
    const root = await makeExecRoot();
    await makeScript(root, "tool.sh", "");
    await expect(
      validateExecCommandRegistry(root, [{ ...command(root), fixedArgs: ["-c", "print(1)"] }])
    ).rejects.toMatchObject({ code: "invalid_input" } satisfies Partial<ExecError>);
    await expect(
      validateExecCommandRegistry(root, [{ ...command(root), fixedArgs: ["--eval"] }])
    ).rejects.toMatchObject({ code: "invalid_input" } satisfies Partial<ExecError>);
  });

  it("rejects a malformed registry shape via Zod", () => {
    expect(() => parseExecCommandRegistry([{ commandId: 123 }])).toThrowError(
      expect.objectContaining({ code: "invalid_input" }) as Partial<ExecError>
    );
    expect(() => parseExecCommandRegistry("not-an-array")).toThrowError(
      expect.objectContaining({ code: "invalid_input" }) as Partial<ExecError>
    );
    expect(() => parseExecCommandRegistry([{ commandId: "x", commandClass: "nope" }])).toThrowError(
      expect.objectContaining({ code: "invalid_input" }) as Partial<ExecError>
    );
  });

  it("rejects a maxOutputBytes over the hard ceiling via Zod", () => {
    const entry = {
      commandId: "x",
      binaryPath: "/b",
      fixedArgs: [],
      allowExtraArgs: false,
      maxExtraArgs: 0,
      cwdMode: "fixed" as const,
      fixedEnv: {},
      allowStdin: false,
      commandClass: "inspect" as const,
      maxOutputBytes: HARD_EXEC_OUTPUT_CEILING_BYTES + 1
    };
    expect(() => parseExecCommandRegistry([entry])).toThrowError(
      expect.objectContaining({ code: "invalid_input" }) as Partial<ExecError>
    );
  });

  it("rejects misleading default constants", () => {
    expect(DEFAULT_MAX_EXEC_OUTPUT_BYTES).toBeGreaterThan(0);
    expect(DEFAULT_EXEC_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
