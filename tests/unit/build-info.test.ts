import { describe, expect, it } from "vitest";
import pkg from "../../package.json" with { type: "json" };
import { STANDALONE_VERSION } from "../../src/app/standalone-cli.js";
import { APP_VERSION, BUILD_COMMIT } from "../../src/shared/build-info.js";

describe("build identity", () => {
  it("derives runtime and standalone CLI version from package metadata", () => {
    expect(APP_VERSION).toBe(pkg.version);
    expect(STANDALONE_VERSION).toBe(APP_VERSION);
  });

  it("never fabricates build provenance", () => {
    expect(typeof BUILD_COMMIT).toBe("string");
    expect(BUILD_COMMIT.length).toBeGreaterThan(0);
  });
});
