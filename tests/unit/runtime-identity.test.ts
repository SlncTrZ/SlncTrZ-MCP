import { describe, expect, it } from "vitest";
import { resolveRuntimeIdentity } from "../../src/standalone/runtime-identity.js";

const rootUser = {
  username: "root",
  uid: 0,
  gid: 0,
  homedir: "/root"
};

const alice = {
  username: "alice",
  uid: 1001,
  gid: 1001,
  homedir: "/home/alice"
};

describe("standalone runtime identity", () => {
  it("uses the current OS user for a normal user install", () => {
    const identity = resolveRuntimeIdentity({
      installMode: "user",
      platform: "linux",
      environment: { PATH: "/opt/alice/bin:/usr/bin" },
      currentUser: alice,
      currentUid: alice.uid,
      lookupGroup: () => "alice"
    });

    expect(identity).toEqual({
      username: "alice",
      uid: 1001,
      gid: 1001,
      groupName: "alice",
      home: "/home/alice",
      runtimePath: "/opt/alice/bin:/usr/bin"
    });
  });

  it("uses the current Windows account for a Win32 user install", () => {
    const windowsUser = {
      username: "DinhTC",
      uid: -1,
      gid: -1,
      homedir: "C:\\Users\\DinhTC"
    };
    const identity = resolveRuntimeIdentity({
      installMode: "user",
      platform: "win32",
      environment: {
        PATH: "C:\\Tools;C:\\Windows\\System32",
        SUDO_USER: "must-not-apply-on-windows"
      },
      currentUser: windowsUser,
      currentUid: 0
    });

    expect(identity).toEqual({
      username: "DinhTC",
      uid: -1,
      gid: -1,
      groupName: "DinhTC",
      home: "C:\\Users\\DinhTC",
      runtimePath: "C:\\Tools;C:\\Windows\\System32"
    });
  });

  it("resolves the original non-root invoking user for sudo system setup", () => {
    const identity = resolveRuntimeIdentity({
      installMode: "system",
      platform: "linux",
      environment: {
        SUDO_USER: "alice",
        PATH: ["/root/.local/bin", "/opt/node-v24/bin", "/usr/bin"].join(":")
      },
      currentUser: rootUser,
      currentUid: 0,
      lookupUser: (username) =>
        username === "alice" ? { uid: alice.uid, gid: alice.gid, home: alice.homedir } : undefined,
      lookupGroup: () => "developers"
    });

    expect(identity).toMatchObject({
      username: "alice",
      uid: 1001,
      gid: 1001,
      groupName: "developers",
      home: "/home/alice"
    });
    expect(identity.runtimePath.split(":")).toContain("/home/alice/.local/bin");
    expect(identity.runtimePath.split(":")).toContain("/opt/node-v24/bin");
    expect(identity.runtimePath.split(":")).not.toContain("/root/.local/bin");
  });

  it("fails loud when sudo claims an invoking user that cannot be resolved", () => {
    expect(() =>
      resolveRuntimeIdentity({
        installMode: "system",
        platform: "linux",
        environment: { SUDO_USER: "ghost", PATH: "/usr/bin" },
        currentUser: rootUser,
        currentUid: 0,
        lookupUser: () => undefined,
        lookupGroup: () => "root"
      })
    ).toThrow("cannot resolve non-root SUDO_USER ghost");
  });

  it("refuses direct root system setup without a non-root invoking identity", () => {
    expect(() =>
      resolveRuntimeIdentity({
        installMode: "system",
        platform: "linux",
        environment: { PATH: "/usr/bin" },
        currentUser: rootUser,
        currentUid: 0,
        lookupGroup: () => "root"
      })
    ).toThrow("system setup run as root requires a valid non-root SUDO_USER");
  });
});
