/**
 * Owner Lifecycle Service — bounded gateway stop/disable/uninstall operations.
 * Wing: owner | Topic: lifecycle | Updated: 2026-08-29
 *
 * This module never exposes a shell or caller-selected service command. Uninstall is
 * limited to explicitly validated SlncTrZ standalone/state roots with ownership markers.
 */

import { spawn } from "node:child_process";
import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";

const SERVICE_NAME = "slnctrz-mcp.service";

export type OwnerLifecycleOperation =
  | { readonly kind: "stop-gateway" }
  | { readonly kind: "disable-gateway" }
  | {
      readonly kind: "uninstall-gateway";
      readonly installRoot: string;
      readonly stateRoot: string;
    };

export interface OwnerLifecycleService {
  execute(operation: OwnerLifecycleOperation): Promise<{
    readonly action: OwnerLifecycleOperation["kind"];
    readonly scheduledStop: boolean;
    readonly removedRoots?: readonly string[];
  }>;
}

export type ServiceControl = (args: readonly string[]) => Promise<void>;

async function systemctl(args: readonly string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("systemctl", [...args], {
      shell: false,
      stdio: ["ignore", "ignore", "ignore"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("service_control_timeout"));
    }, 15_000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("service_control_failed"));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error("service_control_failed"));
    });
  });
}

function validateManagedRoot(root: string): string {
  if (!isAbsolute(root)) throw new Error("managed_root_must_be_absolute");
  const normalized = resolve(root);
  if (normalized === parse(normalized).root || basename(normalized) === "..") {
    throw new Error("managed_root_invalid");
  }
  return normalized;
}

async function assertPlainDirectory(root: string): Promise<void> {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("managed_root_invalid");
  // Compare the resolved path against the canonical location of the root (not the raw
  // string): Windows temp dirs on CI use 8.3 short names (e.g. RUNNER~1) that realpath
  // expands, so a naive `realpath(root) !== root` would reject a normal directory. A
  // symlink/junction still fails because realpath(root) resolves to its target.
  const canonicalParent = await realpath(dirname(root));
  if ((await realpath(root)) !== join(canonicalParent, basename(root))) {
    throw new Error("managed_root_invalid");
  }
}

async function assertStandaloneInstallRoot(root: string): Promise<void> {
  await assertPlainDirectory(root);
  let activation: unknown;
  try {
    activation = JSON.parse(await readFile(`${root}/current.json`, "utf8")) as unknown;
  } catch {
    throw new Error("standalone_install_marker_missing");
  }
  if (typeof activation !== "object" || activation === null || Array.isArray(activation)) {
    throw new Error("standalone_install_marker_invalid");
  }
}

async function assertStateRoot(root: string): Promise<void> {
  await assertPlainDirectory(root);
  try {
    const policy = JSON.parse(await readFile(`${root}/policy.json`, "utf8")) as unknown;
    if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
      throw new Error("managed_state_marker_invalid");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "managed_state_marker_invalid") throw error;
    throw new Error("managed_state_marker_missing");
  }
}

function rootsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function createOwnerLifecycleService(
  options: {
    readonly serviceControl?: ServiceControl;
    readonly scheduleStop?: () => void;
  } = {}
): OwnerLifecycleService {
  const serviceControl = options.serviceControl ?? systemctl;
  const scheduleStop =
    options.scheduleStop ??
    (() => {
      const timer = setTimeout(() => process.kill(process.pid, "SIGTERM"), 100);
      timer.unref();
    });

  const service: OwnerLifecycleService = {
    async execute(operation) {
      if (operation.kind === "stop-gateway") {
        scheduleStop();
        return { action: operation.kind, scheduledStop: true };
      }
      if (operation.kind === "disable-gateway") {
        await serviceControl(["disable", SERVICE_NAME]);
        scheduleStop();
        return { action: operation.kind, scheduledStop: true };
      }

      const installRoot = validateManagedRoot(operation.installRoot);
      const stateRoot = validateManagedRoot(operation.stateRoot);
      if (rootsOverlap(installRoot, stateRoot)) throw new Error("managed_roots_overlap");
      await assertStandaloneInstallRoot(installRoot);
      await assertStateRoot(stateRoot);
      await serviceControl(["disable", SERVICE_NAME]);
      await rm(stateRoot, { recursive: true, force: false });
      await rm(installRoot, { recursive: true, force: false });
      scheduleStop();
      return {
        action: operation.kind,
        scheduledStop: true,
        removedRoots: [installRoot, stateRoot]
      };
    }
  };
  return Object.freeze(service);
}
