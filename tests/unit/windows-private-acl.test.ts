import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureWindowsPrivateAcl,
  type WindowsPrivateAclKind
} from "../../src/shared/windows-private-acl.js";

const cleanup: string[] = [];
const SYSTEM_SID = "S-1-5-18";
const BUILTIN_USERS_SID = "S-1-5-32-545";

function systemBinary(name: string): string {
  const root = process.env.SystemRoot ?? process.env.WINDIR;
  if (!root) throw new Error("windows_system_root_missing");
  return join(root, "System32", `${name}.exe`);
}

function currentUserSid(): string {
  const result = spawnSync(systemBinary("whoami"), ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000
  });
  const sid = result.stdout.match(/S-\d+(?:-\d+)+/u)?.[0];
  if (result.error || result.status !== 0 || !sid) throw new Error("test_current_sid_failed");
  return sid;
}

function runIcacls(path: string, args: string[] = []) {
  return spawnSync(systemBinary("icacls"), [path, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000
  });
}

function aclEntries(path: string): string[] {
  const result = runIcacls(path);
  if (result.error || result.status !== 0) throw new Error("test_acl_read_failed");
  const fileName = basename(path);
  return result.stdout
    .replace(/\r/gu, "")
    .split("\n")
    .map((line, index) => {
      if (index === 0 && line.toLowerCase().startsWith(path.toLowerCase())) {
        return line.slice(path.length).trim();
      }
      if (index === 0 && line.toLowerCase().startsWith(fileName.toLowerCase())) {
        return line.slice(fileName.length).trim();
      }
      return line.trim();
    })
    .filter((line) => /:((?:\([^)]*\))+)$/.test(line));
}

function readDaclSddl(path: string): string {
  const scratch = mkdtempSync(join(tmpdir(), "slnctrz-test-acl-"));
  const savedAcl = join(scratch, "acl.txt");
  try {
    const result = runIcacls(path, ["/save", savedAcl]);
    if (result.error || result.status !== 0) throw new Error("test_acl_save_failed");
    const sddl = readFileSync(savedAcl, "utf16le")
      .replace(/\r/gu, "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("D:"));
    if (!sddl) throw new Error("test_acl_sddl_missing");
    return sddl;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function normalizeTrustee(trustee: string, currentSid: string): string {
  if (trustee === "SY") return SYSTEM_SID;
  if (trustee === "BU") return BUILTIN_USERS_SID;
  if (trustee === "LA") return currentSid;
  return trustee;
}

function sidIsPresent(path: string, sid: string): boolean {
  // `LA` in the saved SDDL always means the current user is the RID-500 local
  // Administrator on CI runners; resolve it to the real current-user SID (not the
  // query `sid`, which may be BUILTIN Users / SYSTEM when checking those).
  const current = currentUserSid();
  const trustees = [...readDaclSddl(path).matchAll(/\(([^()]*)\)/gu)]
    .map((match) => match[1]?.split(";")[5])
    .filter((trustee): trustee is string => trustee !== undefined)
    .map((trustee) => normalizeTrustee(trustee, current));
  return trustees.includes(sid);
}

function expectPrivateAcl(path: string, kind: WindowsPrivateAclKind): void {
  const entries = aclEntries(path);
  expect(entries).toHaveLength(2);
  expect(sidIsPresent(path, currentUserSid())).toBe(true);
  expect(sidIsPresent(path, SYSTEM_SID)).toBe(true);
  for (const entry of entries) {
    expect(entry).not.toContain("(I)");
    expect(entry).toContain("(F)");
    if (kind === "directory") {
      expect(entry).toContain("(OI)");
      expect(entry).toContain("(CI)");
    }
  }
}

async function fixture(name = "target.txt") {
  const root = await mkdtemp(join(tmpdir(), "slnctrz-win-acl-"));
  cleanup.push(root);
  const path = join(root, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "secret\n", "utf8");
  return { root, path };
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describeWindows("Windows private ACL", () => {
  it("hardens a file and remains idempotent", async () => {
    const { path } = await fixture();
    ensureWindowsPrivateAcl(path, "file");
    expectPrivateAcl(path, "file");
    ensureWindowsPrivateAcl(path, "file");
    expectPrivateAcl(path, "file");
  });

  it("remains idempotent across 100 applications", async () => {
    const { path } = await fixture();
    for (let index = 0; index < 100; index += 1) {
      ensureWindowsPrivateAcl(path, "file");
    }
    expectPrivateAcl(path, "file");
  }, 20_000);

  it("hardens a directory with child inheritance flags", async () => {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-win-acl-dir-"));
    cleanup.push(root);
    ensureWindowsPrivateAcl(root, "directory");
    expectPrivateAcl(root, "directory");
  });

  it("supports nested paths and spaces", async () => {
    const { path } = await fixture(join("nested secrets", "owner passphrase.txt"));
    ensureWindowsPrivateAcl(path, "file");
    ensureWindowsPrivateAcl(path, "file");
    expectPrivateAcl(path, "file");
  });

  it("removes unrelated explicit ACEs", async () => {
    const { path } = await fixture();
    const seed = runIcacls(path, ["/grant", `*${BUILTIN_USERS_SID}:(R)`]);
    expect(seed.status).toBe(0);
    expect(sidIsPresent(path, BUILTIN_USERS_SID)).toBe(true);

    ensureWindowsPrivateAcl(path, "file");

    expect(sidIsPresent(path, BUILTIN_USERS_SID)).toBe(false);
    expectPrivateAcl(path, "file");
  });

  it("survives file content edits between ACL assertions", async () => {
    const { path } = await fixture();
    ensureWindowsPrivateAcl(path, "file");
    await writeFile(path, "changed\n", "utf8");
    ensureWindowsPrivateAcl(path, "file");
    expectPrivateAcl(path, "file");
  });
});
