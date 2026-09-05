import { describe, expect, it } from "vitest";
import { parseRuntimeEnvironmentText } from "../../src/standalone/runtime-env-file.js";

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
});
