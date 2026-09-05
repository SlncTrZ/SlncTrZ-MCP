import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileCommandCatalog } from "../../src/kernel/command-catalog.js";
import {
  DEFAULT_MAX_EXEC_ARGS,
  HARD_EXEC_OUTPUT_CEILING_BYTES,
  HARD_EXEC_TIMEOUT_CEILING_MS,
  MAX_EXEC_ARG_BYTES,
  MAX_EXEC_ARGV_BYTES_POSIX,
  MAX_EXEC_COMMAND_LINE_CHARS_WINDOWS,
  MAX_EXEC_COMMAND_LINE_CHARS_WINDOWS_CMD,
  ExecError,
  executeRunCommand,
  validateExecArgvSize
} from "../../src/kernel/exec.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("executeRunCommand", () => {
  it("executes by default when dryRun is omitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-run-"));
    cleanup.push(root);
    const result = await executeRunCommand(process.execPath, ["-e", "console.log('hi')"], root);
    expect(result.applied).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hi");
  });

  it("executes when dryRun is explicitly false", async () => {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-run-"));
    cleanup.push(root);
    const result = await executeRunCommand(process.execPath, ["-e", "console.log('hi')"], root, {
      dryRun: false
    });
    expect(result.applied).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hi");
  });

  it("returns applied:false only for an explicit dry-run", async () => {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-run-"));
    cleanup.push(root);
    const result = await executeRunCommand(process.execPath, ["-e", "console.log('hi')"], root, {
      dryRun: true
    });
    expect(result.applied).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.cwd).toBe(".");
    expect(result.argv).toEqual(["-e", "console.log('hi')"]);
    expect(result.envKeys).toContain("PATH");
  });

  it("rejects NUL bytes in an argument", async () => {
    await expect(executeRunCommand(process.execPath, ["a\0b"], tmpdir())).rejects.toBeInstanceOf(
      ExecError
    );
  });

  it("rejects an argument count beyond the hard ceiling", async () => {
    const args = new Array(DEFAULT_MAX_EXEC_ARGS + 1).fill("x");
    await expect(executeRunCommand(process.execPath, args, tmpdir())).rejects.toBeInstanceOf(
      ExecError
    );
  });

  it("rejects one argument beyond the per-arg byte ceiling", async () => {
    await expect(
      executeRunCommand(process.execPath, ["x".repeat(MAX_EXEC_ARG_BYTES + 1)], tmpdir())
    ).rejects.toBeInstanceOf(ExecError);
  });

  it("rejects an aggregate POSIX argv beyond the large-workload ceiling", () => {
    const chunk = "x".repeat(Math.floor(MAX_EXEC_ARG_BYTES * 0.9));
    const args = new Array(Math.ceil(MAX_EXEC_ARGV_BYTES_POSIX / chunk.length) + 1).fill(chunk);
    expect(() => validateExecArgvSize(process.execPath, args, "linux")).toThrow(
      "Argument vector exceeds the POSIX byte ceiling"
    );
  });

  it("rejects a native Windows command line beyond the CreateProcess-safe ceiling", () => {
    expect(() =>
      validateExecArgvSize(
        "C:\\Program Files\\SlncTrZ\\slnctrz-mcp.exe",
        ["x".repeat(MAX_EXEC_COMMAND_LINE_CHARS_WINDOWS)],
        "win32"
      )
    ).toThrow("Argument vector exceeds the Windows command-line ceiling");
  });

  it("rejects a Windows command-script line beyond the cmd.exe-safe ceiling", () => {
    expect(() =>
      validateExecArgvSize(
        "C:\\slnctrz-test.cmd",
        ["x".repeat(MAX_EXEC_COMMAND_LINE_CHARS_WINDOWS_CMD)],
        "win32"
      )
    ).toThrow("Argument vector exceeds the Windows command-line ceiling");
  });

  it("rejects timeout and output options beyond their hard ceilings", async () => {
    await expect(
      executeRunCommand(process.execPath, ["--version"], tmpdir(), {
        timeoutMs: HARD_EXEC_TIMEOUT_CEILING_MS + 1
      })
    ).rejects.toBeInstanceOf(ExecError);
    await expect(
      executeRunCommand(process.execPath, ["--version"], tmpdir(), {
        maxOutputBytes: HARD_EXEC_OUTPUT_CEILING_BYTES + 1
      })
    ).rejects.toBeInstanceOf(ExecError);
  });

  it.skipIf(process.platform !== "win32")(
    "executes a PATHEXT .cmd command on Windows",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "slnctrz-run-"));
      cleanup.push(root);
      const catalog = compileCommandCatalog([["npm"]]);
      const binary = catalog.byCommand.get("npm")?.binary;
      expect(binary?.toLowerCase()).toMatch(/npm\.(?:cmd|bat)$/u);
      const result = await executeRunCommand(binary ?? "", ["--version"], root);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+/u);
    }
  );
});
