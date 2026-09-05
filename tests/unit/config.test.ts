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
    expect(config.ownerWebEnabled).toBe(false);
  });

  it("derives a local loopback MCP URL without requiring a public hostname", () => {
    const config = readRuntimeConfig({
      SLNCTRZ_HOST: "127.0.0.1",
      SLNCTRZ_PORT: "9000",
      SLNCTRZ_OWNER_SECRET_HASH: OWNER_HASH
    });
    expect(config.publicMcpUrl.href).toBe("http://127.0.0.1:9000/mcp");
    expect(config.ownerWebEnabled).toBe(true);
    expect(config.allowedHostnames).toContain("127.0.0.1");
  });

  it("requires public HTTPS only for non-loopback exposure and rejects incorrect public URLs", () => {
    expect(() =>
      readRuntimeConfig({
        SLNCTRZ_HOST: "0.0.0.0",
        SLNCTRZ_OWNER_SECRET_HASH: OWNER_HASH
      })
    ).toThrowError("required when SLNCTRZ_HOST is not loopback");

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

  it("rejects product port 0 and inconsistent public Host/Origin allowlists", () => {
    expect(() =>
      readRuntimeConfig({
        SLNCTRZ_PORT: "0",
        SLNCTRZ_OWNER_SECRET_HASH: OWNER_HASH
      })
    ).toThrowError("SLNCTRZ_PORT must be an integer from 1 to 65535");

    expect(() =>
      readRuntimeConfig({
        SLNCTRZ_PUBLIC_URL: "https://mcp.example.com/mcp",
        SLNCTRZ_ALLOWED_HOSTS: "localhost,127.0.0.1",
        SLNCTRZ_OWNER_SECRET_HASH: OWNER_HASH
      })
    ).toThrowError("SLNCTRZ_ALLOWED_HOSTS must include the public MCP hostname");

    expect(() =>
      readRuntimeConfig({
        SLNCTRZ_PUBLIC_URL: "https://mcp.example.com/mcp",
        SLNCTRZ_ALLOWED_HOSTS: "mcp.example.com",
        SLNCTRZ_ALLOWED_ORIGINS: "chatgpt.com",
        SLNCTRZ_OWNER_WEB_ENABLED: "true",
        SLNCTRZ_OWNER_SECRET_HASH: OWNER_HASH
      })
    ).toThrowError("SLNCTRZ_ALLOWED_ORIGINS must include the public MCP hostname");
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

  it("parses an absolute policy file and rejects a relative one", () => {
    const base = {
      SLNCTRZ_PUBLIC_URL: "https://mcp.example.com/mcp",
      SLNCTRZ_OWNER_SECRET_HASH: OWNER_HASH
    };
    expect(
      readRuntimeConfig({ ...base, SLNCTRZ_POLICY_FILE: "/etc/slnctrz/policy.json" }).policyFile
    ).toBe("/etc/slnctrz/policy.json");
    expect(readRuntimeConfig(base).policyFile).toBeUndefined();
    expect(() => readRuntimeConfig({ ...base, SLNCTRZ_POLICY_FILE: "policy.json" })).toThrowError(
      "SLNCTRZ_POLICY_FILE must be an absolute path"
    );
  });

  it("defaults the control plane to loopback and validates telemetry settings", () => {
    const base = {
      SLNCTRZ_PUBLIC_URL: "https://mcp.example.com/mcp",
      SLNCTRZ_OWNER_SECRET_HASH: OWNER_HASH
    };
    const config = readRuntimeConfig(base);
    expect(config.controlHost).toBe("127.0.0.1");
    expect(config.controlPort).toBe(3101);
    expect(config.telemetryEnabled).toBe(true);
    expect(
      readRuntimeConfig({
        ...base,
        SLNCTRZ_CONTROL_HOST: "::1",
        SLNCTRZ_CONTROL_PORT: "0",
        SLNCTRZ_TELEMETRY_ENABLED: "false"
      })
    ).toMatchObject({ controlHost: "::1", controlPort: 0, telemetryEnabled: false });
    expect(() => readRuntimeConfig({ ...base, SLNCTRZ_CONTROL_HOST: "0.0.0.0" })).toThrow(
      "loopback"
    );
    expect(() => readRuntimeConfig({ ...base, SLNCTRZ_TELEMETRY_ENABLED: "1" })).toThrow(
      "true or false"
    );
    expect(readRuntimeConfig({ ...base, SLNCTRZ_OWNER_WEB_ENABLED: "true" }).ownerWebEnabled).toBe(
      true
    );
    expect(() => readRuntimeConfig({ ...base, SLNCTRZ_OWNER_WEB_ENABLED: "1" })).toThrow(
      "true or false"
    );
  });

  it("allows OAuth issuer/resource over HTTP only on loopback", async () => {
    const { OAuthService } = await import("../../src/auth/oauth-service.js");

    expect(
      () =>
        new OAuthService({
          issuer: new URL("http://127.0.0.1:3100"),
          resource: new URL("http://127.0.0.1:3100/mcp"),
          ownerSecretHash: OWNER_HASH
        })
    ).not.toThrow();
    expect(
      () =>
        new OAuthService({
          issuer: new URL("http://192.168.1.5:3100"),
          resource: new URL("http://192.168.1.5:3100/mcp"),
          ownerSecretHash: OWNER_HASH
        })
    ).toThrow("HTTPS or an HTTP loopback");
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
