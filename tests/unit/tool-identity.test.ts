import { describe, it, expect } from "vitest";
import {
  providerOf,
  toolNameOf,
  isValidCanonicalId,
  type ToolRecord,
  type RiskClass
} from "../../src/kernel/tool-identity.js";

describe("tool-identity", () => {
  describe("isValidCanonicalId", () => {
    it("accepts provider-prefixed canonical ids", () => {
      expect(isValidCanonicalId("core.read")).toBe(true);
      expect(isValidCanonicalId("github.search_repositories")).toBe(true);
      expect(isValidCanonicalId("postgres.query")).toBe(true);
    });

    it("rejects malformed canonical ids", () => {
      expect(isValidCanonicalId("")).toBe(false);
      expect(isValidCanonicalId("core")).toBe(false);
      expect(isValidCanonicalId(".read")).toBe(false);
      expect(isValidCanonicalId("core.")).toBe(false);
      expect(isValidCanonicalId("..")).toBe(false);
    });
  });

  describe("providerOf", () => {
    it("extracts the namespace prefix", () => {
      expect(providerOf("core.read")).toBe("core");
      expect(providerOf("github.search_repositories")).toBe("github");
    });
  });

  describe("toolNameOf", () => {
    it("extracts the trailing tool name", () => {
      expect(toolNameOf("core.read")).toBe("read");
      expect(toolNameOf("core.search")).toBe("search");
      expect(toolNameOf("github.search_repositories")).toBe("search_repositories");
    });
  });

  describe("ToolRecord", () => {
    const record: ToolRecord = {
      canonicalId: "core.read",
      exposedName: "read",
      providerId: "core",
      schemaHash: "sha256:abc123",
      riskClass: "read" satisfies RiskClass,
      availability: "ready",
      version: "0.1.0"
    };

    it("preserves canonical fields", () => {
      expect(record.canonicalId).toBe("core.read");
      expect(record.riskClass).toBe("read");
      expect(record.availability).toBe("ready");
    });
  });
});
