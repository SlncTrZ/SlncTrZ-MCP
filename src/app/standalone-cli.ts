/**
 * Standalone CLI — explicit local install, rollback, help, and version commands.
 * Wing: distribution | Topic: standalone-cli | Updated: 2026-08-28
 *
 * Provenance: PLAN Phase 8 and ADR-008.
 */

import { isAbsolute } from "node:path";
import { fetchReleaseManifest } from "../standalone/manifest-fetch.js";
import { currentReleaseTarget } from "../standalone/release-manifest.js";
import { installStandaloneRelease, rollbackStandaloneRelease } from "../standalone/installer.js";

export const STANDALONE_VERSION = "0.1.0";

export interface CliOutput {
  write(message: string): void;
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0) throw new Error(`Missing ${name}`);
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`Missing ${name}`);
  return value;
}

function requireOnlyOptions(args: readonly string[], allowed: readonly string[]): void {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== undefined && allowed.includes(argument)) {
      index += 1;
      continue;
    }
    throw new Error(`Unknown standalone CLI argument: ${argument}`);
  }
}

function requireAbsoluteRoot(value: string): string {
  if (!isAbsolute(value)) throw new Error("Standalone install root must be absolute");
  return value;
}

function help(): string {
  return [
    "Usage: slnctrz-mcp [command]",
    "",
    "Commands:",
    "  install --manifest <https-url> --root <absolute-path>",
    "  rollback --root <absolute-path>",
    "  --help",
    "  --version"
  ].join("\n");
}

export async function runStandaloneCli(
  args: readonly string[],
  options: { readonly output?: CliOutput; readonly fetch?: typeof fetch } = {}
): Promise<boolean> {
  const output = options.output ?? { write: (message: string) => console.log(message) };
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === "--help") {
    output.write(help());
    return true;
  }
  if (args.length === 1 && args[0] === "--version") {
    output.write(STANDALONE_VERSION);
    return true;
  }
  if (args[0] === "install") {
    const values = args.slice(1);
    requireOnlyOptions(values, ["--manifest", "--root"]);
    const manifest = await fetchReleaseManifest(option(values, "--manifest"), {
      ...(options.fetch === undefined ? {} : { fetch: options.fetch })
    });
    const activation = await installStandaloneRelease({
      installRoot: requireAbsoluteRoot(option(values, "--root")),
      manifest,
      target: currentReleaseTarget(),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch })
    });
    output.write(
      JSON.stringify({ version: activation.version, previousVersion: activation.previousVersion })
    );
    return true;
  }
  if (args[0] === "rollback") {
    const values = args.slice(1);
    requireOnlyOptions(values, ["--root"]);
    const activation = await rollbackStandaloneRelease({
      installRoot: requireAbsoluteRoot(option(values, "--root"))
    });
    output.write(JSON.stringify({ version: activation.version }));
    return true;
  }
  throw new Error(`Unknown standalone CLI command: ${args[0]}`);
}
