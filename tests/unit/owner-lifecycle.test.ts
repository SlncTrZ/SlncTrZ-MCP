import { afterEach, describe, expect, it, vi } from "vitest";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOwnerLifecycleService } from "../../src/owner/lifecycle.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function managedRoots() {
  const parent = await mkdtemp(join(tmpdir(), "slnctrz-lifecycle-"));
  cleanup.push(parent);
  const installRoot = join(parent, "install");
  const stateRoot = join(parent, "state");
  await mkdir(installRoot);
  await mkdir(stateRoot);
  await writeFile(join(installRoot, "current.json"), JSON.stringify({ version: "0.1.0" }), "utf8");
  await writeFile(
    join(stateRoot, "policy.json"),
    JSON.stringify({ schemaVersion: 1, workspaces: [] }),
    "utf8"
  );
  return { parent, installRoot, stateRoot };
}

describe("owner lifecycle service", () => {
  it("disables the fixed service before removing only validated managed roots", async () => {
    const { installRoot, stateRoot } = await managedRoots();
    const serviceControl = vi.fn(async () => undefined);
    const scheduleStop = vi.fn();
    const service = createOwnerLifecycleService({ serviceControl, scheduleStop });

    const result = await service.execute({ kind: "uninstall-gateway", installRoot, stateRoot });

    expect(serviceControl).toHaveBeenCalledWith(["disable", "slnctrz-mcp.service"]);
    expect(scheduleStop).toHaveBeenCalledOnce();
    expect(result.removedRoots).toEqual([installRoot, stateRoot]);
    await expect(lstat(installRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed for unsafe, overlapping, symlinked, or unmarked roots", async () => {
    const { parent, installRoot, stateRoot } = await managedRoots();
    const serviceControl = vi.fn(async () => undefined);
    const service = createOwnerLifecycleService({ serviceControl, scheduleStop: vi.fn() });

    await expect(
      service.execute({ kind: "uninstall-gateway", installRoot: "/", stateRoot })
    ).rejects.toThrow("managed_root_invalid");
    await expect(
      service.execute({ kind: "uninstall-gateway", installRoot, stateRoot: installRoot })
    ).rejects.toThrow("managed_roots_overlap");

    const symlinkRoot = join(parent, "install-link");
    await symlink(installRoot, symlinkRoot, process.platform === "win32" ? "junction" : "dir");
    await expect(
      service.execute({ kind: "uninstall-gateway", installRoot: symlinkRoot, stateRoot })
    ).rejects.toThrow("managed_root_invalid");

    const unmarked = join(parent, "unmarked");
    await mkdir(unmarked);
    await expect(
      service.execute({ kind: "uninstall-gateway", installRoot: unmarked, stateRoot })
    ).rejects.toThrow("standalone_install_marker_missing");
    expect(serviceControl).not.toHaveBeenCalled();
  });
});
