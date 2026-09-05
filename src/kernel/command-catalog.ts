/**
 * Command Catalog — global command allowlist (command.json) + PATH resolver.
 * Wing: kernel | Topic: command-catalog | Updated: 2026-08-29
 *
 * Provenance: _runtime/core-exec-command-allowlist-handoff.md (Slice 1).
 *
 * The owner-facing `command.json` is a simple allowlist of executables and, optionally,
 * the first subcommand token(s) they may run. It is compiled into an immutable catalog:
 * each executable name is resolved to a canonical absolute binary path via the trusted
 * gateway PATH, and subcommand-restricted rules carry their allowed subcommands.
 */

import { accessSync, realpathSync, statSync } from "node:fs";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import * as z from "zod/v4";

/** One compiled allowlist rule. */
export type CommandRule =
  | {
      readonly kind: "general";
      readonly command: string;
      readonly binary: string;
    }
  | {
      readonly kind: "subcommand";
      readonly command: string;
      readonly subcommands: readonly string[];
      readonly binary: string;
    };

/** Immutable compiled command catalog, keyed for O(1) lookup and deterministic hashing. */
export interface CompiledCommandCatalog {
  readonly rules: readonly CommandRule[];
  /** Map from command name to the rule granting it (there is exactly one rule per name). */
  readonly byCommand: ReadonlyMap<string, CommandRule>;
}

/** Error raised for catalog schema/resolution failures. */
export class CommandCatalogError extends Error {
  readonly code: "invalid_catalog" | "unresolved_executable";

  constructor(code: "invalid_catalog" | "unresolved_executable", message: string) {
    super(message);
    this.name = "CommandCatalogError";
    this.code = code;
  }
}

const allowlistSchema = z
  .object({
    shell: z
      .object({
        allowlist: z
          .object({
            added: z
              .array(z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(64)]))
              .max(512)
          })
          .strict()
          .optional()
      })
      .strict()
      .optional()
  })
  .strict();

/** Resolve a path to a real regular file that is executable, or return undefined. */
function isExecutableFile(path: string): boolean {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return false;
  }
  try {
    accessSync(real, constants.X_OK);
  } catch {
    return false;
  }
  try {
    return statSync(real).isFile();
  } catch {
    return false;
  }
}

/**
 * Parse an owner `command.json` into raw (unresolved) allowlist entries.
 * Throws {@link CommandCatalogError} on schema or normalization failure.
 */
export function parseCommandAllowlist(raw: unknown): readonly (readonly string[])[] {
  const parsed = allowlistSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CommandCatalogError(
      "invalid_catalog",
      `command.json is not a valid allowlist: ${parsed.error.issues[0]?.message ?? "invalid value"}`
    );
  }
  const added = parsed.data.shell?.allowlist?.added ?? [];
  const entries: (readonly string[])[] = [];
  for (const entry of added) {
    if (typeof entry === "string") {
      if (entry.trim().length === 0) {
        throw new CommandCatalogError("invalid_catalog", "command entry is empty");
      }
      entries.push([entry.trim()]);
    } else {
      entries.push(entry.map((token) => token.trim()).filter((token) => token.length > 0));
    }
  }
  return entries;
}

/**
 * Resolve a parsed allowlist against a PATH value into a compiled immutable catalog.
 * Each executable name is resolved to a canonical absolute regular file; unresolved
 * or non-regular-file targets are rejected (fail-closed at compile time).
 */
export function resolveCommandBinary(
  name: string,
  pathValue: string = process.env.PATH ?? ""
): string {
  if (isAbsolute(name)) {
    if (!isExecutableFile(name)) {
      throw new CommandCatalogError("unresolved_executable", `executable ${name} not found`);
    }
    return realpathSync(name);
  }
  const searchDirs = pathValue
    .split(delimiter)
    .map((dir) => dir.trim())
    .filter((dir) => dir.length > 0);
  for (const dir of searchDirs) {
    const candidates =
      process.platform === "win32"
        ? [
            ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
              .split(";")
              .map((extension) => extension.trim())
              .filter((extension) => extension.length > 0)
              .map((extension) => join(dir, `${name}${extension}`)),
            join(dir, name)
          ]
        : [join(dir, name)];
    for (const candidate of candidates) {
      if (isExecutableFile(candidate)) return realpathSync(candidate);
    }
  }
  throw new CommandCatalogError("unresolved_executable", `executable ${name} not found on PATH`);
}

export function compileCommandCatalog(
  entries: readonly (readonly string[])[],
  pathValue: string = process.env.PATH ?? ""
): CompiledCommandCatalog {
  const rules: CommandRule[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const command = entry[0];
    if (command === undefined) {
      throw new CommandCatalogError("invalid_catalog", "command entry has no name");
    }
    if (seen.has(command)) {
      throw new CommandCatalogError("invalid_catalog", `duplicate command rule: ${command}`);
    }
    seen.add(command);
    const binary = resolveCommandBinary(command, pathValue);
    if (entry.length === 1) {
      rules.push({ kind: "general", command, binary });
    } else {
      rules.push({
        kind: "subcommand",
        command,
        subcommands: Object.freeze(entry.slice(1)),
        binary
      });
    }
  }

  const byCommand = new Map<string, CommandRule>();
  for (const rule of rules) byCommand.set(rule.command, rule);

  return Object.freeze({ rules: Object.freeze(rules), byCommand });
}

/** True when a compiled subcommand rule allows `token` as its first argv token. */
export function ruleAllowsToken(rule: CommandRule, token: string): boolean {
  if (rule.kind === "general") return true;
  return rule.subcommands.includes(token);
}

/** Match and resolve the authorized binary for `command` against the catalog. */
export function matchCatalogCommand(
  catalog: CompiledCommandCatalog,
  command: string,
  firstArg: string | undefined
): { readonly binary: string } | undefined {
  const rule = catalog.byCommand.get(command);
  if (rule === undefined) return undefined;
  if (rule.kind === "subcommand") {
    if (firstArg === undefined || !ruleAllowsToken(rule, firstArg)) return undefined;
  }
  return { binary: rule.binary };
}
