import { describe, expect, it, vi } from "vitest";
import { runApplication } from "../../src/app/application-runner.js";
import { runStandaloneCli, STANDALONE_VERSION } from "../../src/app/standalone-cli.js";

function output(): { readonly lines: string[]; readonly write: (message: string) => void } {
  const lines: string[] = [];
  return { lines, write: (message) => lines.push(message) };
}

describe("standalone CLI", () => {
  it("handles help and version without gateway configuration", async () => {
    const help = output();
    const version = output();
    await expect(runStandaloneCli(["--help"], { output: help })).resolves.toBe(true);
    await expect(runStandaloneCli(["--version"], { output: version })).resolves.toBe(true);
    expect(help.lines.join("\n")).toContain("install --manifest");
    expect(version.lines).toEqual([STANDALONE_VERSION]);
  });

  it("delegates an empty invocation to the normal gateway bootstrap", async () => {
    const bootstrap = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    await runApplication([], { runCli: runStandaloneCli, bootstrap });
    expect(bootstrap).toHaveBeenCalledOnce();
  });

  it("rejects malformed and non-absolute mutation commands", async () => {
    await expect(runStandaloneCli(["unknown"])).rejects.toThrow("Unknown standalone CLI command");
    await expect(runStandaloneCli(["install", "--root", "/tmp/install"])).rejects.toThrow(
      "Missing --manifest"
    );
    await expect(runStandaloneCli(["rollback", "--root", "relative"])).rejects.toThrow("absolute");
  });
});
