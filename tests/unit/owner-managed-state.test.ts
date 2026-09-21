import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileCommandCatalog } from "../../src/kernel/command-catalog.js";
import { compilePolicyDocument, loadPolicyDocument } from "../../src/policy/policy-config.js";
import { buildActivePolicySnapshot } from "../../src/policy/policy-snapshot.js";
import { createPolicySnapshotStore } from "../../src/policy/policy-store.js";
import {
  ensureManagedStateLayout,
  ensureRuntimeWorkspacePolicy,
  initializeDefaultWorkspace,
  loadCommandCatalogState,
  managedStatePaths,
  resolveApplicationRoot
} from "../../src/owner/managed-state.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const stateRoot = await mkdtemp(join(tmpdir(), "slnctrz-state-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "slnctrz-workspace-"));
  cleanup.push(stateRoot, workspaceRoot);
  return { workspaceRoot, paths: managedStatePaths(stateRoot) };
}

describe("managed owner state", () => {
  it("derives durable OAuth and Debate state from the managed state root", async () => {
    const { paths } = await fixture();
    expect(paths.oauthStaticRedirectsFile).toBe(join(paths.root, "oauth-static-redirects.json"));
    expect(paths.oauthGrantsDatabaseFile).toBe(join(paths.root, "oauth-grants.sqlite3"));
    expect(paths.debateDatabaseFile).toBe(join(paths.root, "debate.sqlite3"));
    expect(paths.lifecycleIntentFile).toBe(join(paths.root, "lifecycle-intent.json"));
  });

  it.skipIf(process.platform === "win32")(
    "reasserts private directory modes on an existing managed-state layout",
    async () => {
      const { paths } = await fixture();
      await Promise.all([
        chmod(paths.root, 0o755),
        import("node:fs/promises").then(({ mkdir }) =>
          Promise.all([
            mkdir(paths.mcpDirectory, { recursive: true, mode: 0o755 }),
            mkdir(paths.mcpCredentialsDirectory, { recursive: true, mode: 0o755 }),
            mkdir(paths.secretsDirectory, { recursive: true, mode: 0o755 })
          ])
        )
      ]);
      await Promise.all([
        chmod(paths.mcpDirectory, 0o755),
        chmod(paths.mcpCredentialsDirectory, 0o755),
        chmod(paths.secretsDirectory, 0o755)
      ]);

      await ensureManagedStateLayout(paths);

      for (const path of [
        paths.root,
        paths.mcpDirectory,
        paths.mcpCredentialsDirectory,
        paths.secretsDirectory
      ]) {
        expect((await stat(path)).mode & 0o777).toBe(0o700);
      }
    }
  );

  it("creates schema v2 with one shared Paths list", async () => {
    const { paths, workspaceRoot } = await fixture();
    await initializeDefaultWorkspace({ paths, root: workspaceRoot });
    const policy = await loadPolicyDocument(paths.policyFile);
    expect(policy).toEqual({
      schemaVersion: 2,
      paths: [workspaceRoot],
      authorityMode: "restricted"
    });
    const compiled = await compilePolicyDocument(policy);
    expect(compiled.kernelPolicy.readRoots).toEqual([workspaceRoot]);
    expect(compiled.kernelPolicy.writeRoots).toEqual([workspaceRoot]);
    expect(compiled.kernelPolicy.runRoots).toEqual([workspaceRoot]);
  });

  it("provisions a missing command catalog and diagnoses invalid existing content without broadening authority", async () => {
    const { paths } = await fixture();

    const provisioned = await loadCommandCatalogState(paths, resolveApplicationRoot());
    expect(provisioned.status).toBe("ready");
    if (provisioned.status === "ready") {
      expect(provisioned.catalog.rules.length).toBeGreaterThan(0);
    }

    await writeFile(paths.commandCatalogFile, "{not-json\n", "utf8");
    const invalid = await loadCommandCatalogState(paths, resolveApplicationRoot());
    expect(invalid.status).toBe("invalid");
    if (invalid.status === "invalid") {
      expect(invalid.errorCode).toBe("command_catalog_invalid");
      expect(invalid.path).toBe(paths.commandCatalogFile);
      expect(invalid.message.length).toBeGreaterThan(0);
    }
  });

  it("keeps an existing mixed valid/missing catalog strict across startup and reload", async () => {
    const { paths, workspaceRoot } = await fixture();
    await initializeDefaultWorkspace({ paths, root: workspaceRoot });
    const missingBinary = "slnctrz-definitely-missing-command";
    const ownerBytes = `${JSON.stringify(
      { shell: { allowlist: { added: ["node", missingBinary] } } },
      null,
      2
    )}\n`;
    await writeFile(paths.commandCatalogFile, ownerBytes, "utf8");

    const loadSnapshot = async () => {
      const commandState = await loadCommandCatalogState(paths, resolveApplicationRoot());
      const compiled = await compilePolicyDocument(
        await loadPolicyDocument(paths.policyFile),
        commandState.status === "ready" ? commandState.catalog : undefined
      );
      return { commandState, snapshot: buildActivePolicySnapshot(compiled) };
    };

    const startup = await loadSnapshot();
    expect(startup.commandState.status).toBe("invalid");
    expect(startup.snapshot.normalized.kernelPolicy.capabilities).not.toContain("core.exec");
    expect(await readFile(paths.commandCatalogFile, "utf8")).toBe(ownerBytes);

    const store = createPolicySnapshotStore(
      async () => (await loadSnapshot()).snapshot,
      startup.snapshot
    );
    const reload = await store.reload();
    expect(reload).toMatchObject({ activated: true, result: "activated" });
    expect(store.capture().normalized.kernelPolicy.capabilities).not.toContain("core.exec");
    expect(await readFile(paths.commandCatalogFile, "utf8")).toBe(ownerBytes);
  });

  it.skipIf(process.platform === "win32")(
    "derives core.exec from Paths plus command.json",
    async () => {
      const { paths, workspaceRoot } = await fixture();
      await initializeDefaultWorkspace({ paths, root: workspaceRoot });
      const compiled = await compilePolicyDocument(
        await loadPolicyDocument(paths.policyFile),
        compileCommandCatalog([["node"]])
      );
      expect(compiled.kernelPolicy.capabilities).toContain("core.exec");
    }
  );

  it("runtime startup refuses legacy policy migration and preserves the original bytes", async () => {
    const { paths, workspaceRoot } = await fixture();
    const legacy = `${JSON.stringify({
      schemaVersion: 1,
      workspaces: [{ id: "default", roots: { read: workspaceRoot }, profiles: ["read-only"] }],
      fallbackWorkspaceId: "default",
      clientBindings: []
    })}\n`;
    await writeFile(paths.policyFile, legacy, "utf8");

    await expect(
      ensureRuntimeWorkspacePolicy({ paths, root: workspaceRoot })
    ).rejects.toMatchObject({
      code: "policy_migration_required"
    });
    expect(await readFile(paths.policyFile, "utf8")).toBe(legacy);
  });

  it("runtime creates only a missing current policy and preserves a current policy", async () => {
    const { paths, workspaceRoot } = await fixture();
    await ensureRuntimeWorkspacePolicy({ paths, root: workspaceRoot });
    const created = await readFile(paths.policyFile, "utf8");
    expect(JSON.parse(created)).toEqual({
      schemaVersion: 2,
      paths: [workspaceRoot],
      authorityMode: "restricted"
    });
    await ensureRuntimeWorkspacePolicy({ paths, root: workspaceRoot });
    expect(await readFile(paths.policyFile, "utf8")).toBe(created);
  });

  it("preserves malformed existing policy bytes and fails instead of replacing them", async () => {
    const { paths, workspaceRoot } = await fixture();
    const malformed = "{ definitely-not-json\n";
    await writeFile(paths.policyFile, malformed, "utf8");

    await expect(initializeDefaultWorkspace({ paths, root: workspaceRoot })).rejects.toMatchObject({
      code: "policy_file_invalid"
    });
    expect(await readFile(paths.policyFile, "utf8")).toBe(malformed);
  });

  it("does not rewrite a valid current policy during bootstrap", async () => {
    const { paths, workspaceRoot } = await fixture();
    const exact = `${JSON.stringify({ schemaVersion: 2, paths: [workspaceRoot] })}\n`;
    await writeFile(paths.policyFile, exact, "utf8");

    await initializeDefaultWorkspace({ paths, root: workspaceRoot });

    expect(await readFile(paths.policyFile, "utf8")).toBe(exact);
  });

  it("migrates legacy workspace state once, backs it up, and persists only schema v2", async () => {
    const { paths, workspaceRoot } = await fixture();
    const secondRoot = await mkdtemp(join(tmpdir(), "slnctrz-workspace-2-"));
    cleanup.push(secondRoot);
    await writeFile(
      paths.policyFile,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          workspaces: [
            { id: "bootstrap", roots: { read: workspaceRoot }, profiles: ["read-only"] },
            {
              id: "default",
              roots: { read: workspaceRoot, write: secondRoot, run: workspaceRoot },
              profiles: ["custom"]
            }
          ],
          fallbackWorkspaceId: "bootstrap",
          clientBindings: [{ clientId: "old-client", workspaceIds: ["bootstrap"] }]
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    const legacyBytes = await readFile(paths.policyFile, "utf8");
    await initializeDefaultWorkspace({ paths, root: workspaceRoot });
    expect(await readFile(`${paths.policyFile}.v1.backup`, "utf8")).toBe(legacyBytes);
    expect(JSON.parse(await readFile(paths.policyFile, "utf8"))).toEqual({
      schemaVersion: 2,
      paths: [workspaceRoot, secondRoot],
      authorityMode: "restricted"
    });
    await initializeDefaultWorkspace({ paths, root: workspaceRoot });
    expect(JSON.parse(await readFile(paths.policyFile, "utf8"))).toEqual({
      schemaVersion: 2,
      paths: [workspaceRoot, secondRoot],
      authorityMode: "restricted"
    });
  });
});
