import { describe, expect, it } from "vitest";
import {
  currentReleaseTarget,
  parseReleaseManifest,
  selectReleaseArtifact
} from "../../src/standalone/release-manifest.js";

const SHA256 = "a".repeat(64);

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    version: "1.2.3",
    artifacts: [
      {
        target: "linux-x64",
        url: "https://downloads.example.test/slnctrz-mcp-1.2.3-linux-x64",
        sha256: SHA256,
        sizeBytes: 42,
        fileName: "slnctrz-mcp"
      }
    ],
    ...overrides
  };
}

describe("standalone release manifest", () => {
  it("accepts a strict checksummed HTTPS artifact manifest", () => {
    expect(parseReleaseManifest(manifest())).toEqual({
      schemaVersion: 1,
      version: "1.2.3",
      artifacts: [
        {
          target: "linux-x64",
          url: "https://downloads.example.test/slnctrz-mcp-1.2.3-linux-x64",
          sha256: SHA256,
          sizeBytes: 42,
          fileName: "slnctrz-mcp"
        }
      ]
    });
  });

  it("rejects ambiguous, mutable and unsafe artifact declarations", () => {
    expect(() => parseReleaseManifest({ ...manifest(), unexpected: true })).toThrow(
      "unknown field"
    );
    expect(() => parseReleaseManifest(manifest({ version: "latest" }))).toThrow("version");
    expect(() =>
      parseReleaseManifest(
        manifest({
          artifacts: [
            {
              target: "linux-x64",
              url: "http://downloads.example.test/artifact",
              sha256: SHA256,
              sizeBytes: 42,
              fileName: "slnctrz-mcp"
            }
          ]
        })
      )
    ).toThrow("HTTPS");
    expect(() =>
      parseReleaseManifest(
        manifest({
          artifacts: [
            {
              target: "linux-x64",
              url: "https://user:pass@downloads.example.test/artifact",
              sha256: SHA256,
              sizeBytes: 42,
              fileName: "slnctrz-mcp"
            }
          ]
        })
      )
    ).toThrow("userinfo");
    expect(() =>
      parseReleaseManifest(
        manifest({
          artifacts: [
            {
              target: "linux-x64",
              url: "https://downloads.example.test/artifact",
              sha256: "not-a-hash",
              sizeBytes: 42,
              fileName: "slnctrz-mcp"
            }
          ]
        })
      )
    ).toThrow("SHA-256");
  });

  it("rejects duplicate targets and unsafe names before installation", () => {
    expect(() =>
      parseReleaseManifest(
        manifest({
          artifacts: [
            {
              target: "linux-x64",
              url: "https://downloads.example.test/slnctrz-mcp-1.2.3-linux-x64",
              sha256: SHA256,
              sizeBytes: 42,
              fileName: "slnctrz-mcp"
            },
            {
              target: "linux-x64",
              url: "https://downloads.example.test/second",
              sha256: "b".repeat(64),
              sizeBytes: 1,
              fileName: "second"
            }
          ]
        })
      )
    ).toThrow("duplicate target");
    expect(() =>
      parseReleaseManifest(
        manifest({
          artifacts: [
            {
              target: "linux-x64",
              url: "https://downloads.example.test/artifact",
              sha256: SHA256,
              sizeBytes: 42,
              fileName: "../escape"
            }
          ]
        })
      )
    ).toThrow("fileName");
  });

  it("selects one exact target and maps only supported host platforms", () => {
    const parsed = parseReleaseManifest(manifest());
    expect(selectReleaseArtifact(parsed, "linux-x64").fileName).toBe("slnctrz-mcp");
    expect(() => selectReleaseArtifact(parsed, "win32-x64")).toThrow("does not contain");
    expect(currentReleaseTarget("linux", "x64")).toBe("linux-x64");
    expect(currentReleaseTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(() => currentReleaseTarget("freebsd", "x64")).toThrow("unsupported");
  });
});
