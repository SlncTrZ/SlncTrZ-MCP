import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(process.cwd(), "skills", "render-technical-video");
const skill = readFileSync(join(root, "SKILL.md"), "utf8");

describe("render-technical-video creative and technical workflow contract", () => {
  it("remains discoverable with valid frontmatter and /brag-inspired direction", () => {
    expect(skill).toMatch(/^---\nname: render-technical-video\ndescription: >-/u);
    expect(skill).toContain("latent-spaces/brag");
    expect(skill).toContain("authentic");
    expect(skill).toContain("technical");
  });

  it("references existing mode, evidence, style and delivery guidance", () => {
    const resources = [
      "references/creative.md",
      "references/design.md",
      "references/contract.md",
      "references/quality.md",
      "references/production.md",
      "references/audio.md",
      "references/delivery.md",
      "references/linux-runner.md",
      "assets/plan-template.md",
      "assets/template.html",
      "scripts/render.mjs",
      "scripts/package.mjs"
    ];
    for (const resource of resources) {
      expect(existsSync(join(root, resource)), resource).toBe(true);
      expect(skill, resource).toContain(resource);
    }
  });

  it("requires owner-reviewed styleframes, real product proof and truthful limits", () => {
    expect(skill).toMatch(/styleframes/u);
    expect(skill).toMatch(/approval before a long\/full render/u);
    expect(skill).toMatch(/native Blender/u);
    expect(skill).toMatch(/window\.video\.render\(t\)/u);
    expect(skill).toMatch(/Do not claim "native 4K"/u);
    expect(skill).toMatch(/SHA-256 fingerprints/u);
    expect(skill).toContain("authorized");
  });
});
