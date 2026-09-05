/** Platform-specific installed-product paths and executable naming. */

import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface UserPlatformLayout {
  readonly installRoot: string;
  readonly stateRoot: string;
  readonly configRoot: string;
  readonly launcherFileName: string;
  readonly executableFileName: string;
  readonly launcherKind: "posix-script" | "native-copy";
}

export function userPlatformLayout(
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir()
): UserPlatformLayout {
  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA?.trim() || win32.join(home, "AppData", "Local");
    const appData = environment.APPDATA?.trim() || win32.join(home, "AppData", "Roaming");
    return Object.freeze({
      installRoot: win32.join(localAppData, "SlncTrZ-MCP"),
      stateRoot: win32.join(home, ".slnctrz-mcp"),
      configRoot: win32.join(appData, "SlncTrZ-MCP"),
      launcherFileName: "slnctrz-mcp.exe",
      executableFileName: "slnctrz-mcp.exe",
      launcherKind: "native-copy"
    });
  }

  return Object.freeze({
    installRoot: posix.join(home, ".local", "share", "slnctrz-mcp"),
    stateRoot: posix.join(home, ".slnctrz-mcp"),
    configRoot: posix.join(home, ".config", "slnctrz-mcp"),
    launcherFileName: "slnctrz-mcp-launcher",
    executableFileName: "slnctrz-mcp",
    launcherKind: "posix-script"
  });
}

export function releaseExecutableFileName(platform = process.platform): string {
  return platform === "win32" ? "slnctrz-mcp.exe" : "slnctrz-mcp";
}
