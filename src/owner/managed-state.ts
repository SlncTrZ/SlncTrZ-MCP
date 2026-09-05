/**
 * Managed Owner State — simple default paths, command catalog and MCP state layout.
 */

import { access, chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  compilePolicyDocument,
  loadPolicyDocument,
  type PolicyDocument
} from "../policy/policy-config.js";
import {
  compileCommandCatalog,
  parseCommandAllowlist,
  type CompiledCommandCatalog
} from "../kernel/command-catalog.js";
import { readStandaloneTextAsset } from "../standalone/assets.js";
import { ensureWindowsPrivateAcl } from "../shared/windows-private-acl.js";

export const DEFAULT_WORKSPACE_ID = "default";

export const DEFAULT_WORKSPACE_CAPABILITIES = [
  "core.read",
  "core.search",
  "core.write",
  "core.edit",
  "core.exec"
] as const;

export function resolveApplicationRoot(): string {
  try {
    return fileURLToPath(new URL("../../", import.meta.url));
  } catch {
    return process.cwd();
  }
}

export interface ManagedStatePaths {
  readonly root: string;
  readonly policyFile: string;
  readonly commandCatalogFile: string;
  readonly mcpDirectory: string;
  readonly mcpProvidersFile: string;
  readonly mcpCredentialsDirectory: string;
  readonly secretsDirectory: string;
  readonly ownerPassphraseFile: string;
  readonly auditDatabaseFile: string;
  readonly installationMetadataFile: string;
}

export function managedStatePaths(root = join(homedir(), ".slnctrz-mcp")): ManagedStatePaths {
  if (!isAbsolute(root)) throw new Error("Managed state root must be absolute");
  const mcpDirectory = join(root, "mcp");
  const secretsDirectory = join(root, "secrets");
  return Object.freeze({
    root,
    policyFile: join(root, "policy.json"),
    commandCatalogFile: join(root, "command.json"),
    mcpDirectory,
    mcpProvidersFile: join(mcpDirectory, "providers.json"),
    mcpCredentialsDirectory: join(mcpDirectory, "credentials"),
    secretsDirectory,
    ownerPassphraseFile: join(secretsDirectory, "owner-passphrase"),
    auditDatabaseFile: join(root, "audit.sqlite3"),
    installationMetadataFile: join(root, "installation.json")
  });
}

export async function ensureManagedStateLayout(paths: ManagedStatePaths): Promise<void> {
  const directories = [
    paths.root,
    paths.mcpDirectory,
    paths.mcpCredentialsDirectory,
    paths.secretsDirectory
  ];
  await Promise.all(directories.map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  if (process.platform === "win32") {
    for (const path of directories) ensureWindowsPrivateAcl(path, "directory");
  } else {
    await Promise.all(directories.map((path) => chmod(path, 0o700)));
  }
}

export async function managedPolicyExists(paths: ManagedStatePaths): Promise<boolean> {
  try {
    await access(paths.policyFile, constants.F_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function ensureCommandCatalog(
  paths: ManagedStatePaths,
  appRoot: string
): Promise<void> {
  try {
    await access(paths.commandCatalogFile, constants.F_OK);
    return;
  } catch {
    // Fresh install only.
  }
  const templateName = process.platform === "win32" ? "commands.win32.json" : "commands.json";
  let template: string | undefined;
  try {
    template = await readFile(join(appRoot, "config", templateName), "utf8");
  } catch {
    template = readStandaloneTextAsset(`config/${templateName}`);
  }
  if (template === undefined) return;
  await writeFile(paths.commandCatalogFile, template, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
}

export type CommandCatalogLoadState =
  | {
      readonly status: "ready";
      readonly path: string;
      readonly catalog: CompiledCommandCatalog;
    }
  | {
      readonly status: "missing";
      readonly path: string;
      readonly errorCode: "command_catalog_missing";
    }
  | {
      readonly status: "invalid";
      readonly path: string;
      readonly errorCode: "command_catalog_invalid";
      readonly message: string;
    };

export async function loadCommandCatalogState(
  paths: ManagedStatePaths,
  appRoot: string
): Promise<CommandCatalogLoadState> {
  await ensureCommandCatalog(paths, appRoot);
  let raw: string;
  try {
    raw = await readFile(paths.commandCatalogFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        status: "missing",
        path: paths.commandCatalogFile,
        errorCode: "command_catalog_missing"
      };
    }
    return {
      status: "invalid",
      path: paths.commandCatalogFile,
      errorCode: "command_catalog_invalid",
      message: error instanceof Error ? error.message : "Command catalog could not be read"
    };
  }
  try {
    return {
      status: "ready",
      path: paths.commandCatalogFile,
      catalog: compileCommandCatalog(parseCommandAllowlist(JSON.parse(raw) as unknown))
    };
  } catch (error) {
    return {
      status: "invalid",
      path: paths.commandCatalogFile,
      errorCode: "command_catalog_invalid",
      message: error instanceof Error ? error.message : "Command catalog is invalid"
    };
  }
}

export async function loadCommandCatalog(
  paths: ManagedStatePaths,
  appRoot: string
): Promise<CompiledCommandCatalog | undefined> {
  const state = await loadCommandCatalogState(paths, appRoot);
  return state.status === "ready" ? state.catalog : undefined;
}

async function writePolicyAtomically(path: string, document: PolicyDocument): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Ensure the daemon has a current policy without performing schema migration. Missing state may be
 * created for source/developer bootstrap, but an existing legacy policy must be migrated explicitly
 * by setup/update before normal runtime startup.
 */
export async function ensureRuntimeWorkspacePolicy(options: {
  readonly paths: ManagedStatePaths;
  readonly root: string;
}): Promise<void> {
  if (!isAbsolute(options.root)) throw new Error("Default workspace root must be absolute");
  await ensureManagedStateLayout(options.paths);
  if (!(await managedPolicyExists(options.paths))) {
    const document: PolicyDocument = {
      schemaVersion: 2,
      paths: [options.root],
      authorityMode: "restricted"
    };
    await compilePolicyDocument(document);
    await writePolicyAtomically(options.paths.policyFile, document);
    return;
  }

  const original = await readFile(options.paths.policyFile, "utf8");
  let schemaVersion: unknown;
  try {
    schemaVersion = (JSON.parse(original) as { schemaVersion?: unknown }).schemaVersion;
  } catch {
    // loadPolicyDocument below returns the stable invalid-policy diagnostic.
  }
  if (schemaVersion === 1) {
    const error = new Error(
      "policy_migration_required: legacy schema v1 policy must be migrated by setup/update before daemon startup"
    ) as NodeJS.ErrnoException;
    error.code = "policy_migration_required";
    throw error;
  }
  const current = await loadPolicyDocument(options.paths.policyFile);
  await compilePolicyDocument(current);
}

/**
 * Initialize fresh policy state or migrate one valid legacy-v1 policy. Existing invalid state is
 * never replaced: callers must surface the validation error and preserve the original bytes.
 * This is a setup/update primitive, not the normal daemon-startup migration path.
 */
export async function initializeDefaultWorkspace(options: {
  readonly paths: ManagedStatePaths;
  readonly root: string;
  readonly authorityMode?: "restricted" | "autonomous";
}): Promise<void> {
  if (!isAbsolute(options.root)) throw new Error("Default workspace root must be absolute");
  await ensureManagedStateLayout(options.paths);

  if (await managedPolicyExists(options.paths)) {
    const original = await readFile(options.paths.policyFile, "utf8");
    let schemaVersion: unknown;
    try {
      schemaVersion = (JSON.parse(original) as { schemaVersion?: unknown }).schemaVersion;
    } catch {
      // loadPolicyDocument provides the stable policy_file_invalid diagnostic below.
    }
    const prior = await loadPolicyDocument(options.paths.policyFile);
    await compilePolicyDocument(prior);

    if (schemaVersion !== 1) {
      // Current valid policy is runtime-owned state: bootstrap must not rewrite it.
      return;
    }

    const backup = `${options.paths.policyFile}.v1.backup`;
    try {
      await copyFile(options.paths.policyFile, backup, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await writePolicyAtomically(options.paths.policyFile, prior);
    return;
  }

  const document: PolicyDocument = {
    schemaVersion: 2,
    paths: [options.root],
    authorityMode: options.authorityMode ?? "restricted"
  };
  await compilePolicyDocument(document);
  await writePolicyAtomically(options.paths.policyFile, document);
}
