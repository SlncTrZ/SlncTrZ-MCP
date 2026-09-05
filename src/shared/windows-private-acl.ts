/** Windows private ACL helper for managed secret/state files. */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SYSTEM_SID = "S-1-5-18";
const ACL_COMMAND_TIMEOUT_MS = 15_000;
let cachedCurrentUserSid: string | undefined;

export type WindowsPrivateAclKind = "file" | "directory";

interface ParsedAce {
  readonly type: string;
  readonly flags: string;
  readonly rights: string;
  readonly trustee: string;
}

function windowsSystemBinary(name: string): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) throw new Error("windows_private_acl_failed");
  return join(systemRoot, "System32", `${name}.exe`);
}

function spawnWindowsBinary(binary: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(binary, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: ACL_COMMAND_TIMEOUT_MS
  });
}

function commandSucceeded(result: SpawnSyncReturns<string>): boolean {
  return result.error === undefined && result.status === 0;
}

function currentUserSid(): string {
  if (cachedCurrentUserSid !== undefined) return cachedCurrentUserSid;
  const result = spawnWindowsBinary(windowsSystemBinary("whoami"), ["/user", "/fo", "csv", "/nh"]);
  const sid = result.stdout.match(/S-\d+(?:-\d+)+/u)?.[0];
  if (!commandSucceeded(result) || sid === undefined) {
    throw new Error("windows_private_acl_failed");
  }
  cachedCurrentUserSid = sid;
  return sid;
}

function runIcacls(path: string, args: string[] = []): SpawnSyncReturns<string> {
  return spawnWindowsBinary(windowsSystemBinary("icacls"), [path, ...args]);
}

function readDaclSddl(path: string): string | undefined {
  const scratch = mkdtempSync(join(tmpdir(), "slnctrz-acl-verify-"));
  const savedAcl = join(scratch, "acl.txt");
  try {
    const result = runIcacls(path, ["/save", savedAcl]);
    if (!commandSucceeded(result)) return undefined;
    const text = readFileSync(savedAcl, "utf16le");
    return text
      .replace(/\r/gu, "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("D:"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function parseDacl(sddl: string): { readonly control: string; readonly aces: ParsedAce[] } {
  const firstAce = sddl.indexOf("(");
  const control = firstAce === -1 ? sddl.slice(2) : sddl.slice(2, firstAce);
  const aces: ParsedAce[] = [];
  for (const match of sddl.matchAll(/\(([^()]*)\)/gu)) {
    const fields = match[1]?.split(";") ?? [];
    if (fields.length < 6) continue;
    aces.push({
      type: fields[0] ?? "",
      flags: fields[1] ?? "",
      rights: fields[2] ?? "",
      trustee: fields[5] ?? ""
    });
  }
  return { control, aces };
}

/**
 * Map an SDDL trustee alias back to a SID. `icacls /save` abbreviates well-known
 * principals to aliases (SY, LA, BA, BU, ...). On GitHub-hosted Windows runners the
 * gateway user is the RID-500 local Administrator, so its grant is saved as `LA`
 * rather than the full SID — without this mapping the private-ACL self-check would
 * report a correct DACL as a failure. `LA` only ever represents the current user
 * here because this code always grants `*<currentSid>`.
 */
function normalizeTrustee(trustee: string, currentSid: string): string {
  switch (trustee) {
    case "SY":
      return SYSTEM_SID;
    case "LA":
      return currentSid;
    default:
      return trustee;
  }
}

function hasExpectedAceFlags(flags: string, kind: WindowsPrivateAclKind): boolean {
  if (kind === "file") return flags === "";
  const tokens = flags.match(/.{2}/gu) ?? [];
  return tokens.length === 2 && tokens.includes("OI") && tokens.includes("CI");
}

function hasExpectedPrivateAcl(path: string, kind: WindowsPrivateAclKind, sid: string): boolean {
  const sddl = readDaclSddl(path);
  if (sddl === undefined) return false;
  const { control, aces } = parseDacl(sddl);
  if (!control.includes("P")) return false;

  const expectedTrustees = new Set([sid, SYSTEM_SID]);
  const actualTrustees = new Set<string>();
  for (const ace of aces) {
    if (ace.type !== "A" || ace.rights !== "FA" || !hasExpectedAceFlags(ace.flags, kind)) {
      return false;
    }
    actualTrustees.add(normalizeTrustee(ace.trustee, sid));
  }
  if (actualTrustees.size !== expectedTrustees.size || aces.length !== expectedTrustees.size) {
    return false;
  }
  for (const trustee of expectedTrustees) {
    if (!actualTrustees.has(trustee)) return false;
  }
  return true;
}

function applyPrivateAcl(path: string, kind: WindowsPrivateAclKind, sid: string): void {
  const reset = runIcacls(path, ["/reset"]);
  if (!commandSucceeded(reset)) throw new Error("windows_private_acl_failed");

  const rights = kind === "directory" ? "(OI)(CI)F" : "(F)";
  const grant = runIcacls(path, [
    "/inheritance:r",
    "/grant:r",
    `*${sid}:${rights}`,
    "/grant:r",
    `*${SYSTEM_SID}:${rights}`
  ]);
  if (!commandSucceeded(grant)) throw new Error("windows_private_acl_failed");
}

/**
 * Ensure a managed Windows path has a private, idempotent DACL containing only the current
 * gateway user and SYSTEM with FullControl. No-op on non-Windows platforms.
 */
export function ensureWindowsPrivateAcl(path: string, kind: WindowsPrivateAclKind): void {
  if (process.platform !== "win32") return;
  const sid = currentUserSid();
  if (hasExpectedPrivateAcl(path, kind, sid)) return;
  applyPrivateAcl(path, kind, sid);
  if (!hasExpectedPrivateAcl(path, kind, sid)) throw new Error("windows_private_acl_failed");
}
