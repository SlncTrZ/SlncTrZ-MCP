import { describe, expect, it } from "vitest";
import {
  parseClientEnvironmentText,
  parseRuntimeEnvironmentText
} from "../../src/standalone/runtime-env-file.js";

describe("runtime environment file", () => {
  it("accepts only the managed runtime allowlist", () => {
    expect(
      parseRuntimeEnvironmentText(
        [
          "SLNCTRZ_HOST=127.0.0.1",
          "SLNCTRZ_PORT=3100",
          "SLNCTRZ_STATE_ROOT=C:\\Users\\Alice\\.slnctrz-mcp",
          ""
        ].join("\n")
      )
    ).toMatchObject({
      SLNCTRZ_HOST: "127.0.0.1",
      SLNCTRZ_PORT: "3100",
      SLNCTRZ_STATE_ROOT: "C:\\Users\\Alice\\.slnctrz-mcp"
    });
  });

  it("keeps managed keys strict and case-sensitive", () => {
    expect(() => parseRuntimeEnvironmentText("slnctrz_port=3100\n")).toThrow(
      "gateway_config_unknown_key"
    );
    expect(() => parseRuntimeEnvironmentText("SLNCTRZ_PORT =3100\n")).toThrow(
      "gateway_config_unknown_key"
    );
  });

  it("rejects unknown keys", () => {
    expect(() => parseRuntimeEnvironmentText("SLNCTRZ_UNKNOWN=value\n")).toThrow(
      "gateway_config_unknown_key"
    );
  });

  it("parses the static client allowlist", () => {
    expect(
      parseClientEnvironmentText(
        [
          "SLNCTRZ_CLIENT_ID=slnctrz-mcp",
          "SLNCTRZ_CLIENT_SECRET=e908f1cf65b38bb07e9308142fb558e784ab5ab9279074d3",
          "SLNCTRZ_CLIENT_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback"
        ].join("\n")
      )
    ).toMatchObject({
      SLNCTRZ_CLIENT_ID: "slnctrz-mcp",
      SLNCTRZ_CLIENT_SECRET: "e908f1cf65b38bb07e9308142fb558e784ab5ab9279074d3"
    });
  });

  it("rejects non-client keys from the client allowlist", () => {
    expect(() => parseClientEnvironmentText("SLNCTRZ_HOST=127.0.0.1\n")).toThrow(
      "client_config_unknown_key"
    );
  });
});
