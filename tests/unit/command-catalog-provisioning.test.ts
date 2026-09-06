import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileCommandCatalog, parseCommandAllowlist } from "../../src/kernel/command-catalog.js";
import {
  loadCommandCatalogState,
  managedStatePaths,
  resolveApplicationRoot
} from "../../src/owner/managed-state.js";
import { provisionDefaultCommandCatalog } from "../../src/owner/command-catalog-provisioning.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(path);
  return path;
}

async function customAppRoot(input: {
  linux?: readonly string[];
  win32?: readonly string[];
}): Promise<string> {
  const root = await directory("slnctrz-command-provision-");
  const config = join(root, "config");
  await mkdir(config, { recursive: true });
  if (input.linux !== undefined) {
    await writeFile(
      join(config, "commands.json"),
      `${JSON.stringify({ shell: { allowlist: { added: input.linux } } }, null, 2)}\n`,
      "utf8"
    );
  }
  if (input.win32 !== undefined) {
    await writeFile(
      join(config, "commands.win32.json"),
      `${JSON.stringify({ shell: { allowlist: { added: input.win32 } } }, null, 2)}\n`,
      "utf8"
    );
  }
  return root;
}

describe("default command catalog provisioning", () => {
  it.skipIf(process.platform === "win32")(
    "discovers the 117 Linux candidates without weakening strict compilation",
    async () => {
      const stateRoot = await directory("slnctrz-command-state-");
      const paths = managedStatePaths(stateRoot);
      const result = await provisionDefaultCommandCatalog({
        paths,
        appRoot: resolveApplicationRoot(),
        platform: "linux",
        pathValue: process.env.PATH ?? ""
      });

      expect(result.status).toBe("created");
      if (result.status !== "created") return;
      expect(result.candidateCount).toBe(117);
      expect(result.retainedCount).toBeGreaterThan(0);
      expect(result.retainedCount).toBeLessThanOrEqual(117);

      const entries = parseCommandAllowlist(
        JSON.parse(await readFile(paths.commandCatalogFile, "utf8")) as unknown
      );
      expect(entries).toHaveLength(result.retainedCount);
      expect(() => compileCommandCatalog(entries, process.env.PATH ?? "")).not.toThrow();
    }
  );

  it("skips an unavailable candidate while preserving an available executable", async () => {
    const appRoot = await customAppRoot({
      linux: [process.execPath, "/definitely-not-installed/slnctrz-missing-command"]
    });
    const stateRoot = await directory("slnctrz-command-state-");
    const paths = managedStatePaths(stateRoot);

    const result = await provisionDefaultCommandCatalog({
      paths,
      appRoot,
      platform: "linux",
      pathValue: process.env.PATH ?? ""
    });

    expect(result).toMatchObject({ status: "created", candidateCount: 2, retainedCount: 1 });
    const entries = parseCommandAllowlist(
      JSON.parse(await readFile(paths.commandCatalogFile, "utf8")) as unknown
    );
    expect(entries).toEqual([[process.execPath]]);
    expect(() => compileCommandCatalog(entries, process.env.PATH ?? "")).not.toThrow();
  });

  it("uses the same discovered strict catalog for runtime missing-file bootstrap", async () => {
    const available = process.execPath;
    const missing =
      process.platform === "win32"
        ? "C:\\definitely-not-installed\\runtime-bootstrap-missing.exe"
        : "/definitely-not-installed/runtime-bootstrap-missing";
    const appRoot = await customAppRoot({
      linux: [available, missing],
      win32: [available, missing]
    });
    const stateRoot = await directory("slnctrz-command-state-");
    const paths = managedStatePaths(stateRoot);

    const state = await loadCommandCatalogState(paths, appRoot);

    expect(state.status).toBe("ready");
    if (state.status !== "ready") return;
    expect(state.catalog.rules).toHaveLength(1);
    expect(state.catalog.rules[0]?.command).toBe(process.execPath);
  });

  it("uses the Windows candidate template when provisioning for win32", async () => {
    const appRoot = await customAppRoot({
      linux: ["/definitely-not-the-selected-template"],
      win32: [process.execPath]
    });
    const stateRoot = await directory("slnctrz-command-state-");
    const paths = managedStatePaths(stateRoot);

    const result = await provisionDefaultCommandCatalog({
      paths,
      appRoot,
      platform: "win32",
      pathValue: process.env.PATH ?? ""
    });

    expect(result).toMatchObject({ status: "created", candidateCount: 1, retainedCount: 1 });
    expect(
      parseCommandAllowlist(JSON.parse(await readFile(paths.commandCatalogFile, "utf8")) as unknown)
    ).toEqual([[process.execPath]]);
  });

  it("preserves an existing owner-edited catalog byte-for-byte", async () => {
    const appRoot = await customAppRoot({ linux: [process.execPath] });
    const stateRoot = await directory("slnctrz-command-state-");
    const paths = managedStatePaths(stateRoot);
    const ownerContent = ` { "shell" : { "allowlist" : { "added" : [${JSON.stringify(process.execPath)}] } } }\n`;
    await writeFile(paths.commandCatalogFile, ownerContent, "utf8");

    const result = await provisionDefaultCommandCatalog({
      paths,
      appRoot,
      platform: "linux",
      pathValue: process.env.PATH ?? ""
    });

    expect(result.status).toBe("preserved");
    expect(await readFile(paths.commandCatalogFile, "utf8")).toBe(ownerContent);
  });

  it("fails loud when the platform candidate template is missing", async () => {
    const appRoot = await customAppRoot({});
    const stateRoot = await directory("slnctrz-command-state-");
    const paths = managedStatePaths(stateRoot);

    await expect(
      provisionDefaultCommandCatalog({
        paths,
        appRoot,
        platform: "linux",
        pathValue: process.env.PATH ?? ""
      })
    ).rejects.toThrow("default command template is missing");
  });

  it("filters a binary rejected by runtime-user verification before persistence", async () => {
    const appRoot = await customAppRoot({ linux: [process.execPath] });
    const stateRoot = await directory("slnctrz-command-state-");
    const paths = managedStatePaths(stateRoot);

    const result = await provisionDefaultCommandCatalog({
      paths,
      appRoot,
      platform: "linux",
      pathValue: process.env.PATH ?? "",
      verifyResolvedBinary: () => false
    });

    expect(result).toMatchObject({ status: "created", candidateCount: 1, retainedCount: 0 });
    expect(
      parseCommandAllowlist(JSON.parse(await readFile(paths.commandCatalogFile, "utf8")) as unknown)
    ).toEqual([]);
  });
});
