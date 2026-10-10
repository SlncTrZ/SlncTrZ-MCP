import type { ProviderIdentity } from "./adapter.js";

/** Keep only bounded, printable handshake fields, never raw provider metadata. */
export function providerIdentity(result: unknown, protocolVersion: string): ProviderIdentity {
  const info =
    typeof result === "object" && result !== null && "serverInfo" in result
      ? result.serverInfo
      : undefined;
  const field = (key: "name" | "version"): string | undefined => {
    if (typeof info !== "object" || info === null || !(key in info)) return undefined;
    const value = (info as Record<string, unknown>)[key];
    return typeof value === "string" &&
      value.length > 0 &&
      value.length <= 128 &&
      !/[\u0000-\u001f\u007f]/u.test(value)
      ? value
      : undefined;
  };
  const name = field("name");
  const version = field("version");
  return Object.freeze({
    ...(name === undefined ? {} : { name }),
    ...(version === undefined ? {} : { version }),
    protocolVersion: protocolVersion.slice(0, 128),
    observedAt: new Date().toISOString()
  });
}
