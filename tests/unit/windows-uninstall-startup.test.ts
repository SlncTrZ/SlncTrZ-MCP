import { spawn, type ChildProcess } from "node:child_process";
import type * as ChildProcessModule from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uninstallProduct } from "../../src/standalone/product-management.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return { ...actual, spawn: vi.fn() };
});

const platform = Object.getOwnPropertyDescriptor(process, "platform");
const execPath = Object.getOwnPropertyDescriptor(process, "execPath");
if (platform === undefined || execPath === undefined) throw new Error("process_descriptor_missing");
const cleanup: string[] = [];

afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  Object.defineProperty(process, "execPath", execPath);
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
  vi.unstubAllEnvs();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "slnctrz-uninstall-startup-"));
  cleanup.push(root);
  const installRoot = join(root, "program");
  const stateRoot = join(root, "state");
  const configRoot = join(root, "config");
  const binary = join(installRoot, "versions", "fixture", "slnctrz-mcp.exe");
  for (const path of [join(installRoot, "versions", "fixture"), stateRoot, configRoot])
    await mkdir(path, { recursive: true });
  const installationId = randomUUID();
  await writeFile(
    join(stateRoot, "installation.json"),
    JSON.stringify({
      schemaVersion: 1,
      installationId,
      installMode: "user",
      installRoot,
      stateRoot,
      configRoot,
      serviceMode: "foreground",
      serviceName: "slnctrz-mcp",
      releaseChannel: "stable",
      host: "127.0.0.1",
      port: 3100,
      authorityMode: "restricted",
      initialPath: root,
      createdAt: "2026-10-08T00:00:00.000Z",
      updatedAt: "2026-10-08T00:00:00.000Z"
    })
  );
  const retained = [
    binary,
    join(installRoot, "current.json"),
    join(installRoot, "slnctrz-mcp.exe"),
    join(stateRoot, "retained-state.txt"),
    join(configRoot, "gateway.env")
  ];
  for (const path of retained) await writeFile(path, "retained");
  await writeFile(
    join(installRoot, "installation-marker.json"),
    JSON.stringify({ schemaVersion: 1, installationId, stateRoot })
  );
  // Select the Windows self-removal branch without changing the host or starting real processes.
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  Object.defineProperty(process, "execPath", { ...execPath, value: binary });
  vi.stubEnv("SystemRoot", root);
  return { stateRoot, retained };
}

describe("Windows uninstall startup failure", () => {
  it.each(["spawn error", "early exit", "no ready acknowledgement"])(
    "preserves every managed file on %s even when purge was requested",
    async (fault) => {
      const f = await fixture();
      const child = new EventEmitter() as ChildProcess;
      child.kill = vi.fn(() => true);
      child.unref = vi.fn(() => child);
      vi.mocked(spawn).mockImplementation(() => {
        if (fault === "spawn error")
          queueMicrotask(() => child.emit("error", new Error("injected spawn failure")));
        if (fault === "early exit") queueMicrotask(() => child.emit("exit", 1));
        return child;
      });
      if (fault === "no ready acknowledgement")
        vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(15_001);
      await expect(
        uninstallProduct({ purgeState: true }, { stateRoot: f.stateRoot })
      ).rejects.toThrow(
        fault === "no ready acknowledgement"
          ? "windows_uninstall_helper_start_timeout"
          : "windows_uninstall_helper_failed"
      );
      expect(spawn).toHaveBeenCalledOnce();
      expect(child.unref).not.toHaveBeenCalled();
      for (const path of f.retained) expect(await readFile(path, "utf8")).toBe("retained");
    }
  );
});
