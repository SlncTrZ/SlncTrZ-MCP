import { describe, expect, it } from "vitest";
import { buildExecEnvironment, ExecEnvironmentError } from "../../src/kernel/exec-environment.js";

describe("command environment directory discovery", () => {
  it("preserves configured Linux home/XDG/gh paths without consulting another account", () => {
    const env = buildExecEnvironment({
      platform: "linux",
      environment: {
        PATH: "/tools:/usr/bin",
        HOME: "/srv/service home/Định",
        XDG_CONFIG_HOME: "/srv/config",
        XDG_DATA_HOME: "/srv/data",
        XDG_CACHE_HOME: "/srv/cache",
        XDG_STATE_HOME: "/srv/state",
        GH_CONFIG_DIR: "/srv/gh config"
      },
      resolveAccountHome: () => {
        throw new Error("must not resolve a different home");
      }
    });
    expect(env.HOME).toBe("/srv/service home/Định");
    expect(env.XDG_CONFIG_HOME).toBe("/srv/config");
    expect(env.XDG_DATA_HOME).toBe("/srv/data");
    expect(env.XDG_CACHE_HOME).toBe("/srv/cache");
    expect(env.XDG_STATE_HOME).toBe("/srv/state");
    expect(env.GH_CONFIG_DIR).toBe("/srv/gh config");
  });

  it("resolves missing Linux HOME from the current OS account with CLI directory defaults", () => {
    const env = buildExecEnvironment({
      platform: "linux",
      environment: {},
      resolveAccountHome: () => "/srv/service-account"
    });
    expect(env.HOME).toBe("/srv/service-account");
    expect(env.PATH).toBe("/usr/bin:/bin");
    for (const key of ["XDG_CONFIG_HOME", "GH_CONFIG_DIR", "SUDO_USER", "USERPROFILE"]) {
      expect(env).not.toHaveProperty(key);
    }
  });

  it("keeps Linux env names case sensitive and the approved execPath override", () => {
    const env = buildExecEnvironment({
      platform: "linux",
      environment: { home: "/wrong", path: "/wrong", PATH: "/parent" },
      execPath: "/approved",
      resolveAccountHome: () => "/service"
    });
    expect(env.HOME).toBe("/service");
    expect(env.PATH).toBe("/approved");
  });

  it("preserves native Windows profile/app-data paths and mixed-case environment keys", () => {
    const env = buildExecEnvironment({
      platform: "win32",
      environment: {
        Path: "C:\\Tools;C:\\Windows",
        userprofile: "C:\\Users\\Định Name",
        AppData: "D:\\Redirected AppData\\Roaming",
        LocalAppData: "D:\\Redirected AppData\\Local",
        systemroot: "C:\\Windows",
        COMSPEC: "C:\\Windows\\System32\\cmd.exe",
        Pathext: ".COM;.EXE;.BAT;.CMD",
        Temp: "C:\\Service Temp",
        TMP: "C:\\Service Temp",
        gh_config_dir: "\\\\server\\share\\gh config"
      }
    });
    expect(env.USERPROFILE).toBe("C:\\Users\\Định Name");
    expect(env.APPDATA).toBe("D:\\Redirected AppData\\Roaming");
    expect(env.LOCALAPPDATA).toBe("D:\\Redirected AppData\\Local");
    expect(env.SystemRoot).toBe("C:\\Windows");
    expect(env.ComSpec).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(env.PATHEXT).toBe(".COM;.EXE;.BAT;.CMD");
    expect(env.TEMP).toBe("C:\\Service Temp");
    expect(env.TMP).toBe("C:\\Service Temp");
    expect(env.GH_CONFIG_DIR).toBe("\\\\server\\share\\gh config");
    expect(env.PATH).toBe("C:\\Tools;C:\\Windows");
    expect(env).not.toHaveProperty("Path");
    expect(env).not.toHaveProperty("HOME");
  });

  it("resolves minimal Windows environment using the actual service account profile", () => {
    const env = buildExecEnvironment({
      platform: "win32",
      environment: { SUDO_USER: "interactive-owner" },
      resolveAccountHome: () => "C:\\Windows\\ServiceProfiles\\LocalService",
      resolveWindowsAppData: () => ({
        roaming: "\\\\server\\share\\service roaming",
        local: "D:\\service local"
      })
    });
    expect(env.USERPROFILE).toBe("C:\\Windows\\ServiceProfiles\\LocalService");
    expect(env.APPDATA).toBe("\\\\server\\share\\service roaming");
    expect(env.LOCALAPPDATA).toBe("D:\\service local");
    expect(env.PATH).toBe("");
    expect(env).not.toHaveProperty("SUDO_USER");
  });

  it("does not replace inherited Windows directories with known-folder fallback", () => {
    const env = buildExecEnvironment({
      platform: "win32",
      environment: { USERPROFILE: "C:\\service", APPDATA: "D:\\configured roaming" },
      resolveWindowsAppData: () => ({ roaming: "E:\\OS roaming", local: "E:\\OS local" })
    });
    expect(env.APPDATA).toBe("D:\\configured roaming");
    expect(env.LOCALAPPDATA).toBe("E:\\OS local");
  });

  it("reports unavailable Windows known folders without guessing or exposing lookup details", () => {
    expect(() =>
      buildExecEnvironment({
        platform: "win32",
        environment: { USERPROFILE: "C:\\service" },
        resolveWindowsAppData: () => {
          throw new Error("internal account lookup detail");
        }
      })
    ).toThrow("Cannot resolve Windows app-data folders for the gateway OS account");
  });

  it("rejects conflicting Windows casing instead of selecting an arbitrary config", () => {
    expect(() =>
      buildExecEnvironment({
        platform: "win32",
        environment: { USERPROFILE: "C:\\service-a", userprofile: "C:\\service-b" }
      })
    ).toThrow("Conflicting command environment keys for USERPROFILE");
  });

  it.each([
    ["linux", { HOME: "" }],
    ["linux", { HOME: "relative-home" }],
    ["linux", { HOME: "/service", XDG_CONFIG_HOME: "relative-config" }],
    ["linux", { HOME: "/service", GH_CONFIG_DIR: "/config\nmalformed" }],
    ["win32", { USERPROFILE: "C:relative" }],
    ["win32", { USERPROFILE: "\\drive-relative" }],
    ["win32", { USERPROFILE: "C:\\service", APPDATA: "relative" }],
    ["win32", { USERPROFILE: "C:\\service", GH_CONFIG_DIR: "relative" }]
  ] as const)("rejects malformed %s directories without exposing their values", (platform, env) => {
    let error: unknown;
    try {
      buildExecEnvironment({ platform, environment: env });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ExecEnvironmentError);
    expect((error as Error).message).toMatch(
      /^Command environment [A-Z_]+ must be an absolute path$/u
    );
  });

  it.each(["linux", "win32"] as const)(
    "fails clearly when the %s OS account home cannot be resolved",
    (platform) => {
      expect(() =>
        buildExecEnvironment({
          platform,
          environment: {},
          resolveAccountHome: () => {
            throw new Error("internal lookup detail");
          }
        })
      ).toThrow(
        /^Cannot resolve command environment (?:HOME|USERPROFILE) for the gateway OS account$/u
      );
    }
  );

  it.each(["linux", "win32"] as const)(
    "does not forward private or code-injection environment in %s",
    (platform) => {
      const home = platform === "win32" ? "C:\\service" : "/service";
      const privateKeys = ["GH_TOKEN", "GITHUB_TOKEN", "API_KEY", "NODE_OPTIONS", "LD_PRELOAD"];
      const env = buildExecEnvironment({
        platform,
        environment: Object.fromEntries(privateKeys.map((key) => [key, "synthetic-marker"])),
        resolveAccountHome: () => home,
        resolveWindowsAppData: () => ({ roaming: "C:\\roaming", local: "C:\\local" })
      });
      for (const key of privateKeys) expect(env).not.toHaveProperty(key);
    }
  );
});
