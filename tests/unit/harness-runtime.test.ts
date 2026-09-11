import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKernelPolicySnapshot } from "../../src/policy/kernel-policy.js";
import {
  discoverContext,
  MAX_INSTRUCTIONS_BYTES,
  MAX_SKILL_BYTES,
  parseSkillMetadata,
  type HarnessActor
} from "../../src/context/discovery.js";
import { CONTEXT_TTL_MS, HarnessRuntime, MAX_CONTEXT_HANDLES } from "../../src/context/runtime.js";
import { ensureHarnessLayout } from "../../src/context/provisioning.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function temp() {
  const root = await mkdtemp(join(tmpdir(), "harness-"));
  directories.push(root);
  return root;
}
function actor(root: string, clientId = "a", version = "one"): HarnessActor {
  return {
    principal: { clientId, scopes: ["mcp:tools"] },
    policy: { ...createKernelPolicySnapshot({ workspaceId: "test", readRoot: root }), version }
  };
}
async function skill(
  root: string,
  name = "review",
  body = "ACTIVATED-INSTRUCTIONS",
  location = "skills"
) {
  await mkdir(join(root, location, name, "references"), { recursive: true });
  await writeFile(
    join(root, location, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: Review code changes\n---\n${body}\n`
  );
  await writeFile(join(root, location, name, "references", "checks.md"), "RESOURCE-ONLY-CONTENT");
}

describe("global context and progressive skill disclosure", () => {
  it("works with only global configuration and discloses exactly the requested tier", async () => {
    const root = await temp();
    await writeFile(join(root, "AGENTS.md"), "GLOBAL-PREFERENCES");
    await skill(root);
    const runtime = new HarnessRuntime(root),
      a = actor(root);
    const boot = await runtime.bootstrap(a);
    expect(JSON.stringify(boot)).toContain("GLOBAL-PREFERENCES");
    expect(boot.catalog).toMatchObject([{ name: "review", description: "Review code changes" }]);
    expect(JSON.stringify(boot)).not.toContain("ACTIVATED-INSTRUCTIONS");
    expect(JSON.stringify(boot)).not.toContain("RESOURCE-ONLY-CONTENT");
    await expect(
      runtime.readSkill(a, boot.contextToken, "review", "references/checks.md")
    ).rejects.toMatchObject({ code: "skill_not_activated" });
    const activated = await runtime.readSkill(a, boot.contextToken, "review");
    expect(activated.content).toContain("ACTIVATED-INSTRUCTIONS");
    expect(activated.content).not.toContain("RESOURCE-ONLY-CONTENT");
    expect(
      (await runtime.readSkill(a, boot.contextToken, "review", "references/checks.md")).content
    ).toBe("RESOURCE-ONLY-CONTENT");
  });

  it("allows absent project instructions and uses deterministic optional project overrides", async () => {
    const root = await temp(),
      project = await temp();
    await skill(root);
    await skill(project, "review", "PROJECT-SKILL", ".agents/skills");
    const runtime = new HarnessRuntime(root),
      a = actor(project);
    const global = await runtime.bootstrap(a);
    expect(global.projectRoot).toBeNull();
    expect(global.catalog[0]?.scope).toBe("global");
    const scoped = await runtime.bootstrap(a, project);
    expect(scoped.catalog).toHaveLength(1);
    expect(scoped.catalog[0]?.scope).toBe("project");
    expect((await runtime.readSkill(a, scoped.contextToken, "review")).content).toContain(
      "PROJECT-SKILL"
    );
    expect(scoped.diagnostics).toContainEqual(
      expect.objectContaining({ code: "skill_shadows_previous" })
    );
    await writeFile(join(project, "AGENTS.md"), "PROJECT-PREFERENCES");
    await expect(runtime.requireContext(a, scoped.contextToken)).rejects.toMatchObject({
      code: "context_stale"
    });
    await expect(runtime.requireContext(a, global.contextToken)).resolves.toBeDefined();
  });

  it("invalidates receipts when instructions, skill bodies or catalog membership change", async () => {
    const root = await temp(),
      runtime = new HarnessRuntime(root),
      a = actor(root);
    let boot = await runtime.bootstrap(a);
    await writeFile(join(root, "AGENTS.md"), "NEW-GLOBAL");
    await expect(runtime.requireContext(a, boot.contextToken)).rejects.toMatchObject({
      code: "context_stale"
    });
    boot = await runtime.bootstrap(a);
    await skill(root);
    await expect(runtime.requireContext(a, boot.contextToken)).rejects.toMatchObject({
      code: "context_stale"
    });
    boot = await runtime.bootstrap(a);
    await skill(root, "review", "CHANGED-BODY");
    await expect(runtime.requireContext(a, boot.contextToken)).rejects.toMatchObject({
      code: "context_stale"
    });
    boot = await runtime.bootstrap(a);
    await rm(join(root, "skills", "review"), { recursive: true });
    await expect(runtime.requireContext(a, boot.contextToken)).rejects.toMatchObject({
      code: "context_stale"
    });
  });

  it("keeps receipts and activation state independent across clients and tasks", async () => {
    const root = await temp(),
      runtime = new HarnessRuntime(root),
      a = actor(root),
      b = actor(root, "b");
    await skill(root);
    const first = await runtime.bootstrap(a),
      second = await runtime.bootstrap(a);
    await expect(runtime.requireContext(b, first.contextToken)).rejects.toMatchObject({
      code: "context_required"
    });
    expect(() => runtime.close(b, first.contextToken)).toThrow();
    await runtime.readSkill(a, first.contextToken, "review");
    await expect(
      runtime.readSkill(a, second.contextToken, "review", "references/checks.md")
    ).rejects.toMatchObject({ code: "skill_not_activated" });
    expect(runtime.close(a, first.contextToken)).toEqual({ closed: true });
    await expect(runtime.requireContext(a, first.contextToken)).rejects.toMatchObject({
      code: "context_required"
    });
    await expect(runtime.requireContext(a, second.contextToken)).resolves.toBeDefined();
    await expect(
      new HarnessRuntime(root).requireContext(a, second.contextToken)
    ).rejects.toMatchObject({ code: "context_required" });
  });

  it("requires renewal after TTL and policy changes without granting filesystem authority", async () => {
    const root = await temp(),
      outside = await temp();
    let now = 1000;
    const runtime = new HarnessRuntime(root, () => now),
      a = actor(root);
    let boot = await runtime.bootstrap(a);
    now += CONTEXT_TTL_MS;
    await expect(runtime.requireContext(a, boot.contextToken)).rejects.toMatchObject({
      code: "context_stale"
    });
    boot = await runtime.bootstrap(a);
    await expect(
      runtime.requireContext(actor(root, "a", "two"), boot.contextToken)
    ).rejects.toMatchObject({ code: "context_stale" });
    await expect(runtime.bootstrap(a, outside)).rejects.toMatchObject({
      code: "project_context_denied"
    });
  });

  it("reclaims receipts invalidated by a policy generation before enforcing capacity", async () => {
    const root = await temp(),
      runtime = new HarnessRuntime(root),
      oldActor = actor(root, "a", "one"),
      newActor = actor(root, "a", "two");
    for (let index = 0; index < MAX_CONTEXT_HANDLES; index += 1) {
      await runtime.bootstrap(oldActor);
    }
    await expect(runtime.bootstrap(newActor)).resolves.toMatchObject({
      schemaVersion: 1,
      projectRoot: null
    });
  }, 15_000);

  it("reclaims instruction-stale receipts before enforcing capacity", async () => {
    const root = await temp(),
      runtime = new HarnessRuntime(root),
      a = actor(root);
    await writeFile(join(root, "AGENTS.md"), "GLOBAL-ONE");
    for (let index = 0; index < MAX_CONTEXT_HANDLES; index += 1) {
      await runtime.bootstrap(a);
    }
    await writeFile(join(root, "AGENTS.md"), "GLOBAL-TWO");
    await expect(runtime.bootstrap(a)).resolves.toMatchObject({
      schemaVersion: 1,
      projectRoot: null,
      instructions: [expect.objectContaining({ content: "GLOBAL-TWO" })]
    });
  }, 15_000);

  it("rejects unsafe resources, invalid UTF-8 and oversized instructions without partial injection", async () => {
    const root = await temp(),
      outside = await temp(),
      runtime = new HarnessRuntime(root),
      a = actor(root);
    await skill(root);
    const boot = await runtime.bootstrap(a);
    await runtime.readSkill(a, boot.contextToken, "review");
    await writeFile(join(outside, "secret.txt"), "PRIVATE");
    await symlink(
      join(outside, "secret.txt"),
      join(root, "skills", "review", "references", "link.txt")
    );
    for (const resource of [
      "../../AGENTS.md",
      "references/link.txt",
      "C:\\private.txt",
      ".env",
      "/etc/passwd"
    ]) {
      await expect(
        runtime.readSkill(a, boot.contextToken, "review", resource)
      ).rejects.toBeDefined();
    }
    await writeFile(join(root, "AGENTS.md"), Buffer.from([0xff, 0xfe]));
    await expect(runtime.bootstrap(a)).rejects.toMatchObject({ code: "instructions_unavailable" });
    await writeFile(join(root, "AGENTS.md"), "x".repeat(MAX_INSTRUCTIONS_BYTES + 1));
    await expect(runtime.bootstrap(a)).rejects.toMatchObject({ code: "instructions_unavailable" });
  });

  it("accepts SKILL.md files up to the 128 KiB product limit and rejects larger files", async () => {
    const root = await temp();
    expect(MAX_SKILL_BYTES).toBe(128 * 1024);
    await skill(root, "large", "x".repeat(96 * 1024));
    await skill(root, "oversized", "x".repeat(MAX_SKILL_BYTES));

    const snapshot = await discoverContext(root);
    expect(snapshot.catalog.map((entry) => entry.name)).toContain("large");
    expect(snapshot.catalog.map((entry) => entry.name)).not.toContain("oversized");
    expect(snapshot.diagnostics).toContainEqual(
      expect.objectContaining({ source: "global/skills/oversized", code: "skill_unreadable" })
    );
  });

  it("isolates malformed skills and never follows a linked skill directory", async () => {
    const root = await temp(),
      outside = await temp();
    await skill(root, "valid");
    await skill(root, "invalid");
    await writeFile(
      join(root, "skills", "invalid", "SKILL.md"),
      "---\nname: invalid\n---\nNO-DESCRIPTION"
    );
    await skill(outside, "external");
    await symlink(
      join(outside, "skills", "external"),
      join(root, "skills", "external"),
      "junction"
    );
    const snapshot = await discoverContext(root);
    expect(snapshot.catalog.map((entry) => entry.name)).toEqual(["valid"]);
    expect(snapshot.diagnostics.map((entry) => entry.code)).toContain("skill_invalid_metadata");
    expect(snapshot.diagnostics.map((entry) => entry.code)).toContain("context_path_denied");
  });

  it("parses real YAML block scalars and rejects duplicate keys or alias expansion", () => {
    expect(
      parseSkillMetadata(
        "---\nname: review\ndescription: >\n  Review code\n  carefully\nmetadata:\n  category: coding\n---\nBody"
      )
    ).toMatchObject({ description: "Review code carefully" });
    for (const yaml of [
      "name: a\nname: b\ndescription: test",
      "name: review\ndescription: &a [*a]",
      "name: BAD\ndescription: test"
    ]) {
      expect(() => parseSkillMetadata(`---\n${yaml}\n---\n`)).toThrow();
    }
  });

  it("seeds a usable installation once and preserves edits and intentional removals", async () => {
    const root = await temp();
    await ensureHarnessLayout(root);
    expect((await discoverContext(root)).catalog.map((entry) => entry.name)).toEqual([
      "code-review",
      "debug-and-test"
    ]);
    await writeFile(join(root, "AGENTS.md"), "OWNER-CUSTOMIZED");
    await rm(join(root, "skills", "code-review"), { recursive: true });
    await ensureHarnessLayout(root);
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("OWNER-CUSTOMIZED");
    expect((await discoverContext(root)).catalog.map((entry) => entry.name)).toEqual([
      "debug-and-test"
    ]);
  });
});
