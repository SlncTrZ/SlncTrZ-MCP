/** Default command-catalog provisioning from platform-specific candidate templates. */

import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CommandCatalogError,
  compileCommandCatalog,
  parseCommandAllowlist,
  resolveCommandBinary
} from "../kernel/command-catalog.js";
import { readStandaloneTextAsset } from "../standalone/assets.js";
import type { ManagedStatePaths } from "./managed-state.js";

export interface CommandCatalogProvisionOptions {
  readonly paths: ManagedStatePaths;
  readonly appRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly pathValue?: string;
  readonly verifyResolvedBinary?: (binary: string) => boolean | Promise<boolean>;
}

export type CommandCatalogProvisionResult =
  | { readonly status: "preserved"; readonly path: string }
  | {
      readonly status: "created";
      readonly path: string;
      readonly candidateCount: number;
      readonly retainedCount: number;
    };

async function candidateAsset(
  appRoot: string,
  platform: NodeJS.Platform
): Promise<string | undefined> {
  const templateName = platform === "win32" ? "commands.win32.json" : "commands.json";
  try {
    return await readFile(join(appRoot, "config", templateName), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return readStandaloneTextAsset(`config/${templateName}`);
}

function serialize(entries: readonly (readonly string[])[]): string {
  const added = entries.map((entry) => (entry.length === 1 ? entry[0] : [...entry]));
  return `${JSON.stringify({ shell: { allowlist: { added } } }, null, 2)}\n`;
}

export async function provisionDefaultCommandCatalog(
  options: CommandCatalogProvisionOptions
): Promise<CommandCatalogProvisionResult> {
  try {
    await access(options.paths.commandCatalogFile, constants.F_OK);
    return { status: "preserved", path: options.paths.commandCatalogFile };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const raw = await candidateAsset(options.appRoot, options.platform ?? process.platform);
  if (raw === undefined) {
    throw new CommandCatalogError("invalid_catalog", "default command template is missing");
  }

  let candidates: readonly (readonly string[])[];
  try {
    candidates = parseCommandAllowlist(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CommandCatalogError("invalid_catalog", "default command template is invalid JSON");
    }
    throw error;
  }

  const pathValue = options.pathValue ?? process.env.PATH ?? "";
  const retained: (readonly string[])[] = [];
  for (const entry of candidates) {
    const command = entry[0];
    if (command === undefined) {
      throw new CommandCatalogError("invalid_catalog", "default command entry has no name");
    }
    try {
      const binary = resolveCommandBinary(command, pathValue);
      if (
        options.verifyResolvedBinary !== undefined &&
        !(await options.verifyResolvedBinary(binary))
      ) {
        continue;
      }
      retained.push(entry);
    } catch (error) {
      if (error instanceof CommandCatalogError && error.code === "unresolved_executable") continue;
      throw error;
    }
  }

  // Security assertion: the exact persisted default must still satisfy the strict compiler.
  compileCommandCatalog(retained, pathValue);
  await writeFile(options.paths.commandCatalogFile, serialize(retained), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  return {
    status: "created",
    path: options.paths.commandCatalogFile,
    candidateCount: candidates.length,
    retainedCount: retained.length
  };
}
