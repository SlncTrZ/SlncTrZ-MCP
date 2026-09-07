import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicyDocument } from "../../src/policy/policy-config.js";
import { runApplication } from "../../src/app/application-runner.js";
import { runStandaloneCli, STANDALONE_VERSION } from "../../src/app/standalone-cli.js";
import { currentReleaseTarget } from "../../src/standalone/release-manifest.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function output() {
  const lines: string[] = [];
  return { lines, write: (message: string) => lines.push(message) };
}

function releaseFetch(bytes: Buffer): typeof fetch {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const target = currentReleaseTarget();
  const manifest = JSON.stringify({
    schemaVersion: 1,
    version: "1.2.3",
    artifacts: [
      {
        target,
        url: "https://objects.example.test/slnctrz-mcp",
        sha256,
        sizeBytes: bytes.byteLength,
        fileName: process.platform === "win32" ? "slnctrz-mcp.exe" : "slnctrz-mcp"
      }
    ]
  });
  return (async (input) =>
    new Response(String(input).includes("manifest") ? manifest : bytes, {
      status: 200
    })) as typeof fetch;
}

describe("standalone CLI", () => {
  it("handles help and version without gateway configuration", async () => {
    const help = output();
    const version = output();
    const buildInfo = output();
    await expect(runStandaloneCli(["--help"], { output: help })).resolves.toBe(true);
    await expect(runStandaloneCli(["--version"], { output: version })).resolves.toBe(true);
    await expect(runStandaloneCli(["--build-info"], { output: buildInfo })).resolves.toBe(true);
    expect(help.lines.join("\n")).toContain("install --manifest");
    expect(version.lines).toEqual([STANDALONE_VERSION]);
    expect(JSON.parse(buildInfo.lines[0] ?? "{}")).toMatchObject({ version: STANDALONE_VERSION });
  });

  it("delegates an empty invocation to normal gateway bootstrap", async () => {
    const bootstrap = vi.fn<() => Promise<undefined>>().mockResolvedValue(undefined);
    await runApplication([], { runCli: runStandaloneCli, bootstrap });
    expect(bootstrap).toHaveBeenCalledOnce();
  });

  it("initializes schema-v2 default Paths state", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "slnctrz-cli-state-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "slnctrz-cli-workspace-"));
    cleanup.push(stateRoot, workspaceRoot);
    const captured = output();
    await expect(
      runStandaloneCli(["owner", "init", "--root", workspaceRoot, "--state-root", stateRoot], {
        output: captured,
        environment: {}
      })
    ).resolves.toBe(true);
    const result = JSON.parse(captured.lines[0] ?? "{}") as { policyFile?: string };
    expect(result.policyFile).toBe(join(stateRoot, "policy.json"));
    expect(await loadPolicyDocument(join(stateRoot, "policy.json"))).toEqual({
      schemaVersion: 2,
      paths: [workspaceRoot],
      authorityMode: "restricted"
    });
  });

  it("forwards custom OAuth credentials through the setup command", async () => {
    const root = await mkdtemp(join(tmpdir(), "slnctrz-cli-setup-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "slnctrz-cli-setup-workspace-"));
    cleanup.push(root, workspaceRoot);
    const configRoot = join(root, "config");
    const captured = output();

    await expect(
      runStandaloneCli(
        [
          "setup",
          "--port",
          "9126",
          "--path",
          workspaceRoot,
          "--manifest",
          "https://updates.example.test/manifest.json",
          "--install-root",
          join(root, "install"),
          "--state-root",
          join(root, "state"),
          "--config-root",
          configRoot,
          "--client-id",
          "cli-client",
          "--client-secret",
          "cli-client-secret"
        ],
        {
          output: captured,
          fetch: releaseFetch(Buffer.from("standalone-bytes")),
          environment: {},
          checkPort: async () => undefined
        }
      )
    ).resolves.toBe(true);

    expect(captured.lines.join("\n")).toContain("Client ID: cli-client");
    expect(await readFile(join(configRoot, "client.env"), "utf8")).toContain(
      ["SLNCTRZ_CLIENT_ID=cli-client", "SLNCTRZ_CLIENT_SECRET=cli-client-secret"].join("\n")
    );
  });

  it("maps bounded owner diagnostics to loopback control requests", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer owner-secret");
      return new Response(JSON.stringify({ ok: true, url: String(input) }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const common = {
      output: output(),
      fetch: fetchMock,
      environment: { SLNCTRZ_OWNER_SECRET: "owner-secret" }
    };
    await runStandaloneCli(["owner", "status"], common);
    await runStandaloneCli(["owner", "policy"], common);
    await runStandaloneCli(["owner", "reload"], common);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects malformed and non-absolute commands", async () => {
    await expect(runStandaloneCli(["unknown"])).resolves.toBe(false);
    await expect(runStandaloneCli(["install", "--root", "/tmp/install"])).rejects.toThrow(
      "Missing --manifest"
    );
    await expect(runStandaloneCli(["rollback", "--root", "relative"])).rejects.toThrow("absolute");
  });
});
