/**
 * Wing: app | Topic: runtime-config | Updated: 2026-08-26
 */

import { describe, expect, it } from "vitest";
import { readRuntimeConfig } from "../../src/app/config.js";
import { createOwnerSecretHash } from "../../src/auth/owner-verifier.js";

const OWNER_HASH = createOwnerSecretHash("correct horse battery staple");

describe("readRuntimeConfig", () => {
  it("parses a generic HTTPS MCP deployment without repository defaults", () => {
    const config = readRuntimeConfig({
      SLNCTRZ_HOST: "0.0.0.0",
      SLNCTRZ_PORT: "3100",
      SLNCTRZ_PUBLIC_URL: "https://mcp.example.com/mcp",
      SLNCTRZ_ALLOWED_HOSTS: "mcp.example.com,localhost",
      SLNCTRZ_ALLOWED_ORIGINS: "chatgpt.com,claude.ai",
      SLNCTRZ_OWNER_SECRET_HASH: OWNER_HASH,
      SLNCTRZ_MAX_DYNAMIC_CLIENTS: "64"
    });

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(3100);
    expect(config.publicMcpUrl.href).toBe("https://mcp.example.com/mcp");
    expect(config.allowedHostnames).toEqual(["mcp.example.com", "localhost"]);
    expect(config.allowedOriginHostnames).toEqual(["chatgpt.com", "claude.ai"]);
    expect(config.maxDynamicClients).toBe(64);
  });

  it("rejects missing, insecure, or incorrectly routed public URLs", () => {
    expect(() => readRuntimeConfig({ SLNCTRZ_OWNER_SECRET_HASH: OWNER_HASH })).toThrowError(
      "SLNCTRZ_PUBLIC_URL is required"
    );

    expect(() =>
      readRuntimeConfig({
        SLNCTRZ_PUBLIC_URL: "http://mcp.example.com/mcp",
        SLNCTRZ_OWNER_SECRET_HASH: OWNER_HASH
      })
    ).toThrowError("HTTPS URL ending at /mcp");

    expect(() =>
      readRuntimeConfig({
        SLNCTRZ_PUBLIC_URL: "https://mcp.example.com/api",
        SLNCTRZ_OWNER_SECRET_HASH: OWNER_HASH
      })
    ).toThrowError("HTTPS URL ending at /mcp");
  });

  it("rejects an invalid dynamic-client capacity", () => {
    const base = {
      SLNCTRZ_PUBLIC_URL: "https://mcp.example.com/mcp",
      SLNCTRZ_OWNER_SECRET_HASH: OWNER_HASH
    };

    expect(() =>
      readRuntimeConfig({
        ...base,
        SLNCTRZ_MAX_DYNAMIC_CLIENTS: "0"
      })
    ).toThrowError("SLNCTRZ_MAX_DYNAMIC_CLIENTS must be a positive integer");

    expect(() =>
      readRuntimeConfig({
        ...base,
        SLNCTRZ_MAX_DYNAMIC_CLIENTS: "1.5"
      })
    ).toThrowError("SLNCTRZ_MAX_DYNAMIC_CLIENTS must be a positive integer");
  });

  it("rejects partial confidential-client credentials", () => {
    const base = {
      SLNCTRZ_PUBLIC_URL: "https://mcp.example.com/mcp",
      SLNCTRZ_OWNER_SECRET_HASH: OWNER_HASH
    };

    expect(() =>
      readRuntimeConfig({
        ...base,
        SLNCTRZ_CLIENT_ID: "static-client"
      })
    ).toThrowError("SLNCTRZ_CLIENT_ID and SLNCTRZ_CLIENT_SECRET must be configured together");

    expect(() =>
      readRuntimeConfig({
        ...base,
        SLNCTRZ_CLIENT_SECRET: "server-side-secret"
      })
    ).toThrowError("SLNCTRZ_CLIENT_ID and SLNCTRZ_CLIENT_SECRET must be configured together");
  });

  it("requires a syntactically valid owner verifier at authority construction", async () => {
    const { OAuthService } = await import("../../src/auth/oauth-service.js");

    expect(
      () =>
        new OAuthService({
          issuer: new URL("https://mcp.example.com"),
          resource: new URL("https://mcp.example.com/mcp"),
          ownerSecretHash: "not-a-verifier"
        })
    ).toThrowError("invalid format");
  });
});
