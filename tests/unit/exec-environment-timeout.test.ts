/**
 * Windows known-folder lookup resilience.
 *
 * Regression for the 2026-10-13 release-gate flake: the real PowerShell probe timed out on a loaded
 * runner under a 3s budget and failed the Windows gate. These tests replace the process boundary so
 * the bounded-retry contract is asserted deterministically on every platform.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import type * as ChildProcessModule from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { buildExecEnvironment } from "../../src/kernel/exec-environment.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return { ...actual, spawnSync: vi.fn() };
});

const LOOKUP_TIMEOUT_MS = 10_000;

function timedOut(): SpawnSyncReturns<string> {
  return {
    error: Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" }),
    status: null,
    stdout: "",
    stderr: "",
    output: [null, "", ""],
    pid: 0,
    signal: null
  } as unknown as SpawnSyncReturns<string>;
}

function succeeded(stdout: string): SpawnSyncReturns<string> {
  return {
    error: undefined,
    status: 0,
    stdout,
    stderr: "",
    output: [null, stdout, ""],
    pid: 1,
    signal: null
  } as unknown as SpawnSyncReturns<string>;
}

function failed(): SpawnSyncReturns<string> {
  return {
    error: undefined,
    status: 1,
    stdout: "",
    stderr: "access denied",
    output: [null, "", "access denied"],
    pid: 1,
    signal: null
  } as unknown as SpawnSyncReturns<string>;
}

/** APPDATA/LOCALAPPDATA deliberately absent: this is the path that consults native known folders. */
function minimalWindowsEnvironment(): NodeJS.ProcessEnv {
  return {
    SystemRoot: "C:\\Windows",
    PATH: "C:\\Windows\\System32",
    USERPROFILE: "C:\\service"
  };
}

describe("windows known-folder lookup resilience", () => {
  it("retries once after a cold-start timeout and then succeeds", () => {
    vi.mocked(spawnSync).mockReset();
    vi.mocked(spawnSync)
      .mockReturnValueOnce(timedOut())
      .mockReturnValueOnce(succeeded("C:\\redirected\\Roaming\r\nC:\\redirected\\Local\r\n"));

    const env = buildExecEnvironment({
      platform: "win32",
      environment: minimalWindowsEnvironment()
    });

    expect(env.APPDATA).toBe("C:\\redirected\\Roaming");
    expect(env.LOCALAPPDATA).toBe("C:\\redirected\\Local");
    expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(2);
    // Budget must stay wide enough for a cold PowerShell start, and the window must stay hidden.
    expect(vi.mocked(spawnSync).mock.calls[0]?.[2]).toMatchObject({
      timeout: LOOKUP_TIMEOUT_MS,
      windowsHide: true
    });
  });

  it("fails closed with the timeout category after exhausting attempts", () => {
    vi.mocked(spawnSync).mockReset();
    vi.mocked(spawnSync).mockReturnValue(timedOut());

    expect(() =>
      buildExecEnvironment({ platform: "win32", environment: minimalWindowsEnvironment() })
    ).toThrow("Windows app-data folder lookup timed out");
    expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-timeout failure, so a real environment fault stays visible", () => {
    vi.mocked(spawnSync).mockReset();
    vi.mocked(spawnSync).mockReturnValue(failed());

    expect(() =>
      buildExecEnvironment({ platform: "win32", environment: minimalWindowsEnvironment() })
    ).toThrow("Cannot resolve Windows app-data folders");
    expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(1);
  });
});
