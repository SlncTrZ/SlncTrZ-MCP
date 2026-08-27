import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compilePolicyDocument } from "../../src/policy/policy-config.js";
import { buildActivePolicySnapshot } from "../../src/policy/policy-snapshot.js";
import {
  serializePolicyAuditEvent,
  type PolicyAuditEvent
} from "../../src/observability/policy-audit.js";

const cleanup: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "slnctrz-adv-"));
  cleanup.push(dir);
  return dir;
}

afterEach(async () => {
  for (const path of cleanup.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

async function writeExecRegistry(dir: string): Promise<string> {
  const script = join(dir, "tool.sh");
  await writeFile(script, "#!/bin/sh\necho ok\n", { mode: 0o755 });
  const binaryReal = await realpath(script);
  const commandsFile = join(dir, "commands.json");
  await writeFile(
    commandsFile,
    JSON.stringify([
      {
        commandId: "tool",
        binaryPath: binaryReal,
        fixedArgs: [],
        allowExtraArgs: false,
        maxExtraArgs: 0,
        cwdMode: "fixed",
        fixedEnv: {},
        allowStdin: false,
        commandClass: "inspect"
      }
    ]),
    "utf8"
  );
  return commandsFile;
}

describe("Phase 4 adversarial: config rejects with no disclosure", () => {
  it("rejects exec/write root overlap without leaking the root path", async () => {
    const dir = await makeTempDir();
    const commandsFile = await writeExecRegistry(dir);
    let caught: unknown;
    try {
      await compilePolicyDocument({
        schemaVersion: 1,
        workspaces: [
          {
            id: "w",
            roots: { write: dir, exec: dir },
            profiles: ["minimal"],
            exec: { commandsFile }
          }
        ]
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).not.toContain(dir);
    expect(message).not.toContain("commands.json");
    expect(message).not.toContain("tool.sh");
  });

  it("rejects secret-like text used as a root path without echoing it", async () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    let caught: unknown;
    try {
      await compilePolicyDocument({
        schemaVersion: 1,
        workspaces: [{ id: "w", roots: { read: secret }, profiles: ["read-only"] }]
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).not.toContain(secret);
  });

  it("rejects a malformed exec command registry without leaking its content", async () => {
    const dir = await makeTempDir();
    const commandsFile = join(dir, "bad.json");
    await writeFile(commandsFile, "{ not valid : json", "utf8");
    let caught: unknown;
    try {
      await compilePolicyDocument({
        schemaVersion: 1,
        workspaces: [
          {
            id: "w",
            roots: { read: "/r", exec: dir },
            profiles: ["minimal"],
            exec: { commandsFile }
          }
        ]
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).not.toContain("{ not valid");
    expect(message).not.toContain("bad.json");
  });

  it("rejects a symlink escape in an exec binary without disclosure", async () => {
    const dir = await makeTempDir();
    const outside = await makeTempDir();
    const secret = join(outside, "secret.txt");
    await writeFile(secret, "secret", "utf8");
    const link = join(dir, "escape.sh");
    try {
      await symlink(secret, link);
    } catch {
      // Symlinks require privileges on some platforms (e.g. Windows); skip that branch.
      return;
    }
    const commandsFile = join(dir, "commands.json");
    await writeFile(
      commandsFile,
      JSON.stringify([
        {
          commandId: "escape",
          binaryPath: link,
          fixedArgs: [],
          allowExtraArgs: false,
          maxExtraArgs: 0,
          cwdMode: "fixed",
          fixedEnv: {},
          allowStdin: false,
          commandClass: "execute"
        }
      ]),
      "utf8"
    );
    let caught: unknown;
    try {
      await compilePolicyDocument({
        schemaVersion: 1,
        workspaces: [
          {
            id: "w",
            roots: { read: "/r", exec: dir },
            profiles: ["minimal"],
            exec: { commandsFile }
          }
        ]
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).not.toContain(outside);
    expect(message).not.toContain("escape.sh");
  });
});

describe("Phase 4 adversarial: immutable snapshot objects", () => {
  it("rejects mutation attempts on the normalized snapshot and its arrays", async () => {
    const dir = await makeTempDir();
    const compiled = await compilePolicyDocument({
      schemaVersion: 1,
      workspaces: [{ id: "alpha", roots: { read: join(dir, "r") }, profiles: ["read-only"] }],
      clientBindings: [{ clientId: "client-a", workspaceIds: ["alpha"] }]
    });
    const snap = buildActivePolicySnapshot(compiled);
    expect(Object.isFrozen(snap.normalized)).toBe(true);
    expect(Object.isFrozen(snap.normalized.workspaces)).toBe(true);
    expect(Object.isFrozen(snap.normalized.clientBindings)).toBe(true);
    expect(() => {
      (snap.normalized as unknown as { workspaces: unknown[] }).workspaces.push({});
    }).toThrow();
  });
});

describe("Phase 4 adversarial: audit redaction across the surface", () => {
  it("serializes a compile audit event with no config-derived identifiers", () => {
    const event: PolicyAuditEvent = {
      timestamp: "2026-08-27T08:00:00.000Z",
      eventType: "policy_compile",
      actorKind: "startup",
      previousVersion: "abcdef1234567890",
      candidateVersion: "abcdef1234567890",
      activeVersion: "abcdef1234567890",
      result: "activated",
      riskIncrease: false,
      workspaceCount: 1,
      bindingCount: 1,
      durationMs: 0
    };
    const line = serializePolicyAuditEvent(event);
    for (const forbidden of ["client-a", "/home", "alpha", "commands.json", "AKIA", "secret"]) {
      expect(line).not.toContain(forbidden);
    }
    expect((JSON.parse(line) as PolicyAuditEvent).eventType).toBe("policy_compile");
  });
});
