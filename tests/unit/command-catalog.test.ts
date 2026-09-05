import { describe, expect, it } from "vitest";
import {
  CommandCatalogError,
  compileCommandCatalog,
  matchCatalogCommand,
  parseCommandAllowlist,
  ruleAllowsToken
} from "../../src/kernel/command-catalog.js";

describe("command catalog", () => {
  it("parses string and array allowlist entries and rejects malformed input", () => {
    const entries = parseCommandAllowlist({
      shell: { allowlist: { added: [["git", "status", "log"], "node"] } }
    });
    expect(entries).toEqual([["git", "status", "log"], ["node"]]);

    expect(() => parseCommandAllowlist({ shell: { allowlist: { added: ["  "] } } })).toThrow(
      CommandCatalogError
    );
    expect(() => parseCommandAllowlist({ shell: { allowlist: { added: [42] } } })).toThrow(
      CommandCatalogError
    );
  });

  it("compiles an empty allowlist into an empty catalog", () => {
    const catalog = compileCommandCatalog([], "/nonexistent");
    expect(catalog.rules.length).toBe(0);
    expect(catalog.byCommand.size).toBe(0);
  });

  it("resolves an executable name to a canonical absolute binary via PATH", () => {
    const catalog = compileCommandCatalog([["node", "--version"]]);
    const rule = catalog.byCommand.get("node");
    expect(rule).toBeDefined();
    expect(rule?.kind).toBe("subcommand");
    expect(rule?.binary).toContain("node");
  });

  it("rejects an unresolved executable name (fail-closed)", () => {
    expect(() => compileCommandCatalog([["absent-tool-xyz-9x7"]])).toThrow(CommandCatalogError);
  });

  it("matches general and subcommand rules and denies unknown/unlisted subcommands", () => {
    const sub = compileCommandCatalog([["node", "--version"]]);
    const allowed = matchCatalogCommand(sub, "node", "--version");
    expect(allowed).toBeDefined();
    const denied = matchCatalogCommand(sub, "node", "delete");
    expect(denied).toBeUndefined();
    expect(matchCatalogCommand(sub, "node", undefined)).toBeUndefined();
    const unknown = matchCatalogCommand(sub, "nothing", "--version");
    expect(unknown).toBeUndefined();

    const general = compileCommandCatalog([["node"]]);
    const generalMatch = matchCatalogCommand(general, "node", "run");
    expect(generalMatch).toBeDefined();
    expect(ruleAllowsToken({ kind: "general", command: "x", binary: "/x" }, "anything")).toBe(true);
  });

  it("rejects duplicate command rules", () => {
    expect(() => compileCommandCatalog([["node"], ["node", "--version"]])).toThrow(
      CommandCatalogError
    );
  });
});
