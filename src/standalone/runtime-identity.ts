/** Resolve the real OS owner/runtime identity for standalone installs. */

import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { posix } from "node:path";
import { homedir, userInfo } from "node:os";

export interface RuntimeIdentity {
  readonly username: string;
  readonly uid: number;
  readonly gid: number;
  readonly groupName: string;
  readonly home: string;
  readonly runtimePath: string;
}

export interface RuntimeIdentityOptions {
  readonly installMode?: "user" | "system";
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly currentUser?: {
    readonly username: string;
    readonly uid: number;
    readonly gid: number;
    readonly homedir: string;
  };
  readonly currentUid?: number;
  readonly lookupUser?: (
    username: string
  ) => { uid: number; gid: number; home: string } | undefined;
  readonly lookupGroup?: (username: string) => string | undefined;
}

function runText(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv
): string | undefined {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    shell: false,
    env: environment
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function passwdEntry(
  username: string,
  environment: NodeJS.ProcessEnv
): { uid: number; gid: number; home: string } | undefined {
  const raw = runText("getent", ["passwd", username], environment);
  if (raw === undefined) return undefined;
  const fields = raw.split(":");
  if (fields.length < 7) return undefined;
  const uid = Number(fields[2]);
  const gid = Number(fields[3]);
  const home = fields[5] ?? "";
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || home.length === 0)
    return undefined;
  return { uid, gid, home };
}

function groupNameFor(username: string, environment: NodeJS.ProcessEnv): string {
  const group = runText("id", ["-gn", username], environment);
  if (group === undefined || group.length === 0) {
    throw new Error(`runtime_identity_invalid: cannot resolve primary group for ${username}`);
  }
  return group;
}

function systemRuntimePath(home: string, inheritedPath: string | undefined): string {
  const inherited = (inheritedPath ?? "")
    .split(":")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry !== "/root" && !entry.startsWith("/root/"));
  return [
    ...new Set([
      posix.join(home, ".local", "bin"),
      posix.join(home, ".npm-global", "bin"),
      ...inherited,
      "/usr/local/sbin",
      "/usr/local/bin",
      "/usr/sbin",
      "/usr/bin",
      "/sbin",
      "/bin",
      "/snap/bin"
    ])
  ].join(":");
}

export function runtimeCanExecuteBinary(
  identity: RuntimeIdentity,
  binary: string,
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  const currentUid = process.getuid?.();
  if (currentUid === undefined || currentUid === identity.uid) {
    try {
      accessSync(binary, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  if (currentUid !== 0) return false;
  const result = spawnSync("runuser", ["-u", identity.username, "--", "test", "-x", binary], {
    encoding: "utf8",
    shell: false,
    env: environment
  });
  return result.status === 0;
}

export function resolveRuntimeIdentity(options: RuntimeIdentityOptions = {}): RuntimeIdentity {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const current = options.currentUser ?? userInfo();
  // Honor $HOME for the real process identity (os.homedir() prefers $HOME over the passwd
  // entry), while preserving an injected currentUser.home for tests and callers that pin it.
  const currentHome =
    options.currentUser === undefined ? homedir() || current.homedir : current.homedir;

  if (platform === "win32") {
    return Object.freeze({
      username: current.username,
      uid: current.uid,
      gid: current.gid,
      groupName: current.username,
      home: currentHome,
      runtimePath: environment.PATH?.trim() || ""
    });
  }

  const currentUid = options.currentUid ?? process.getuid?.() ?? current.uid;
  let username = current.username;
  let uid = current.uid;
  let gid = current.gid;
  let home = currentHome;

  if (currentUid === 0) {
    const sudoUser = environment.SUDO_USER?.trim();
    if (sudoUser !== undefined && sudoUser.length > 0 && sudoUser !== "root") {
      const original =
        options.lookupUser === undefined
          ? passwdEntry(sudoUser, environment)
          : options.lookupUser(sudoUser);
      if (original === undefined || original.uid === 0) {
        throw new Error(`runtime_identity_invalid: cannot resolve non-root SUDO_USER ${sudoUser}`);
      }
      username = sudoUser;
      uid = original.uid;
      gid = original.gid;
      home = original.home;
    } else if (options.installMode === "system") {
      throw new Error(
        "runtime_identity_invalid: system setup run as root requires a valid non-root SUDO_USER"
      );
    }
  }

  const runtimePath =
    options.installMode === "system"
      ? systemRuntimePath(home, environment.PATH)
      : environment.PATH?.trim() || systemRuntimePath(home, undefined);

  return Object.freeze({
    username,
    uid,
    gid,
    groupName:
      options.lookupGroup === undefined
        ? groupNameFor(username, environment)
        : (options.lookupGroup(username) ??
          (() => {
            throw new Error(
              `runtime_identity_invalid: cannot resolve primary group for ${username}`
            );
          })()),
    home,
    runtimePath
  });
}
