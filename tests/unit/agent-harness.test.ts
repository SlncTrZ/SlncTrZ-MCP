import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  AGENT_HARNESS_ID,
  AGENT_HARNESS_SCHEMA_VERSION,
  buildAgentHarnessInstructions,
  extractCanonicalAgentHarness
} from "../../src/shared/agent-harness.js";

describe("canonical product agent harness", () => {
  it("extracts only the universal guidance block from product AGENTS.md", async () => {
    const source = await readFile("AGENTS.md", "utf8");
    const harness = extractCanonicalAgentHarness(source);

    expect(harness.id).toBe(AGENT_HARNESS_ID);
    expect(harness.schemaVersion).toBe(AGENT_HARNESS_SCHEMA_VERSION);
    expect(harness.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(harness.content).toContain("Simplicity first");
    expect(harness.content).toContain("Surgical changes");
    expect(harness.content).toContain("Read before you write");
    expect(harness.content).toContain("Tests verify intent");
    expect(harness.content).toContain("Checkpoint after every step");
    expect(harness.content).toContain("Fail loud");
    expect(harness.content).toContain("Reuse first");
    expect(harness.content).toContain("No self-privilege");

    expect(harness.content).not.toContain("Skills (dự án SlncTrZ-MCP)");
    expect(harness.content).not.toContain("meilin");
    expect(harness.content).not.toContain("MCP-GUIDE.md");
  });

  it("builds server instructions that preserve the guidance/security boundary", async () => {
    const harness = extractCanonicalAgentHarness(await readFile("AGENTS.md", "utf8"));
    const instructions = buildAgentHarnessInstructions(harness);

    expect(instructions).toContain("product working guidance, not authorization");
    expect(instructions).toContain("Kernel/Auth/Policy remain authoritative");
    expect(instructions).toContain(harness.content);
  });

  it("fails loud for missing, duplicated, or empty canonical markers", () => {
    expect(() => extractCanonicalAgentHarness("no markers")).toThrow(
      "agent_harness_markers_invalid"
    );
    expect(() =>
      extractCanonicalAgentHarness(
        [
          "<!-- SLNCTRZ_CANONICAL_AGENT_HARNESS_BEGIN -->",
          "x",
          "<!-- SLNCTRZ_CANONICAL_AGENT_HARNESS_BEGIN -->",
          "<!-- SLNCTRZ_CANONICAL_AGENT_HARNESS_END -->"
        ].join("\n")
      )
    ).toThrow("agent_harness_markers_invalid");
    expect(() =>
      extractCanonicalAgentHarness(
        [
          "<!-- SLNCTRZ_CANONICAL_AGENT_HARNESS_BEGIN -->",
          "",
          "<!-- SLNCTRZ_CANONICAL_AGENT_HARNESS_END -->"
        ].join("\n")
      )
    ).toThrow("agent_harness_empty");
  });
});
