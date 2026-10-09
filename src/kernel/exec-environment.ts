/** Minimal command environment with native account/config directory discovery. */

import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { posix, win32 } from "node:path";

export interface WindowsAppDataDirectories {
  readonly roaming: string;
  readonly local: string;
}

export interface ExecEnvironmentOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly execPath?: string;
  readonly resolveAccountHome?: () => string;
  readonly resolveWindowsAppData?: () => WindowsAppDataDirectories;
}

export class ExecEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecEnvironmentError";
  }
}

const WINDOWS_FOLDER_LOOKUP_TIMEOUT_MS = 3_000;
const WINDOWS_FOLDER_LOOKUP_OUTPUT_BYTES = 64 * 1_024;

function windowsAppDataDirectories(systemRoot: string | undefined): WindowsAppDataDirectories {
  if (process.platform !== "win32" || systemRoot === undefined) {
    throw new Error("Windows account folder lookup unavailable");
  }
  const result = spawnSync(
    win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @{roaming=[Environment]::GetFolderPath('ApplicationData');local=[Environment]::GetFolderPath('LocalApplicationData')} | ConvertTo-Json -Compress"
    ],
    {
      env: { SystemRoot: systemRoot },
      encoding: "utf8",
      timeout: WINDOWS_FOLDER_LOOKUP_TIMEOUT_MS,
      maxBuffer: WINDOWS_FOLDER_LOOKUP_OUTPUT_BYTES,
      windowsHide: true
    }
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("Windows account folder lookup failed");
  }
  const folders = JSON.parse(result.stdout) as unknown;
  if (
    folders === null ||
    typeof folders !== "object" ||
    !("roaming" in folders) ||
    !("local" in folders) ||
    typeof folders.roaming !== "string" ||
    typeof folders.local !== "string"
  ) {
    throw new Error("Windows account folder lookup returned invalid data");
  }
  return { roaming: folders.roaming, local: folders.local };
}

export function buildExecEnvironment(options: ExecEnvironmentOptions = {}): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const parent = options.environment ?? process.env;
  const windows = platform === "win32";
  const paths = windows ? win32 : posix;

  function value(key: string): string | undefined {
    if (!windows) return parent[key];
    const matches = Object.keys(parent).filter(
      (name) => name.toUpperCase() === key.toUpperCase() && parent[name] !== undefined
    );
    const values = new Set(matches.map((name) => parent[name]));
    if (values.size > 1) {
      throw new ExecEnvironmentError(`Conflicting command environment keys for ${key}`);
    }
    return matches.length === 0 ? undefined : parent[matches[0] ?? key];
  }

  function absolutePath(key: string, path: string): string {
    const fullyQualified = windows
      ? /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/iu.test(path)
      : paths.isAbsolute(path);
    if (!fullyQualified || /[\u0000-\u001f\u007f]/u.test(path)) {
      throw new ExecEnvironmentError(`Command environment ${key} must be an absolute path`);
    }
    return path;
  }

  const homeKey = windows ? "USERPROFILE" : "HOME";
  let home = value(homeKey);
  if (home === undefined) {
    try {
      home = (options.resolveAccountHome ?? (() => userInfo().homedir))();
    } catch {
      throw new ExecEnvironmentError(
        `Cannot resolve command environment ${homeKey} for the gateway OS account`
      );
    }
  }
  home = absolutePath(homeKey, home);

  const env: Record<string, string> = {
    PATH: options.execPath ?? value("PATH") ?? (windows ? "" : "/usr/bin:/bin"),
    [homeKey]: home
  };
  const ghConfig = value("GH_CONFIG_DIR");
  if (ghConfig !== undefined) env.GH_CONFIG_DIR = absolutePath("GH_CONFIG_DIR", ghConfig);
  if (windows) {
    for (const key of ["SystemRoot", "ComSpec", "TEMP", "TMP"]) {
      const inherited = value(key);
      if (inherited !== undefined) env[key] = absolutePath(key, inherited);
    }
    const extensions = value("PATHEXT");
    if (extensions !== undefined) env.PATHEXT = extensions;
    const roaming = value("APPDATA");
    const local = value("LOCALAPPDATA");
    if (roaming !== undefined) env.APPDATA = absolutePath("APPDATA", roaming);
    if (local !== undefined) env.LOCALAPPDATA = absolutePath("LOCALAPPDATA", local);
    if (roaming === undefined || local === undefined) {
      // Query actual known folders; app-data paths may be redirected outside USERPROFILE.
      let folders: WindowsAppDataDirectories;
      try {
        folders = (
          options.resolveWindowsAppData ?? (() => windowsAppDataDirectories(env.SystemRoot))
        )();
      } catch {
        throw new ExecEnvironmentError(
          "Cannot resolve Windows app-data folders for the gateway OS account"
        );
      }
      if (roaming === undefined) env.APPDATA = absolutePath("APPDATA", folders.roaming);
      if (local === undefined) env.LOCALAPPDATA = absolutePath("LOCALAPPDATA", folders.local);
    }
  } else {
    for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
      const inherited = value(key);
      if (inherited !== undefined) env[key] = absolutePath(key, inherited);
    }
  }
  return env;
}
