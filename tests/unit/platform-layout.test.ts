import { describe, expect, it } from "vitest";
import { userPlatformLayout } from "../../src/standalone/platform-layout.js";

describe("platform layout", () => {
  it("keeps established Linux user-install roots", () => {
    expect(userPlatformLayout("linux", {}, "/home/alice")).toEqual({
      installRoot: "/home/alice/.local/share/slnctrz-mcp",
      stateRoot: "/home/alice/.slnctrz-mcp",
      configRoot: "/home/alice/.config/slnctrz-mcp",
      launcherFileName: "slnctrz-mcp-launcher",
      executableFileName: "slnctrz-mcp",
      launcherKind: "posix-script"
    });
  });

  it("uses Windows-native user roots and executable naming", () => {
    expect(
      userPlatformLayout(
        "win32",
        {
          LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local",
          APPDATA: "C:\\Users\\Alice\\AppData\\Roaming"
        },
        "C:\\Users\\Alice"
      )
    ).toEqual({
      installRoot: "C:\\Users\\Alice\\AppData\\Local\\SlncTrZ-MCP",
      stateRoot: "C:\\Users\\Alice\\.slnctrz-mcp",
      configRoot: "C:\\Users\\Alice\\AppData\\Roaming\\SlncTrZ-MCP",
      launcherFileName: "slnctrz-mcp.exe",
      executableFileName: "slnctrz-mcp.exe",
      launcherKind: "native-copy"
    });
  });
});
