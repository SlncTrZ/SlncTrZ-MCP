/**
 * Loopback host detection — scoped security gate for the HTTP endpoint exception.
 * Wing: extension | Topic: loopback | Updated: 2026-08-31
 *
 * A streamable-http MCP provider is HTTPS-only by default. This helper admits the single
 * controlled exception: "http:" is allowed only when the host is a loopback address
 * (127.0.0.0/8, localhost, ::1). The check is purely per-host. Per-provider origin binding
 * (scheme + host + port) still applies at the adapter, so a provider bound to 127.0.0.1:3003
 * cannot reach any other port or host.
 *
 * This is intentionally fail-closed: any host that is not a recognised loopback address stays
 * HTTPS-only. See docs/adr/adr-025-loopback-http-endpoint-exception.md.
 */

const LOOPBACK_IPV4 = /^127(?:\.(?:\d{1,3})){3}$/u;

const LOOPBACK_IPV6 = new Set<string>([
  "::1",
  "0:0:0:0:0:0:0:1",
  // IPv4-mapped IPv6 forms of 127.0.0.1.
  "::ffff:127.0.0.1",
  "::ffff:7f00:1"
]);

/** Whether a URL hostname is a loopback address. Accepts the bracket-less IPv6 form too. */
export function isLoopbackHost(hostname: string): boolean {
  const host = (hostname ?? "").trim().toLowerCase();
  if (host === "") return false;
  // RFC 6761: `localhost` and any `.localhost` subdomain always resolve to loopback.
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // RFC 1122 §3.2.1.6: 127.0.0.0/8 is the entire IPv4 loopback range.
  if (LOOPBACK_IPV4.test(host)) {
    return host.split(".").every((octet) => Number(octet) >= 0 && Number(octet) <= 255);
  }
  // URL.hostname carries IPv6 addresses in brackets; accept both forms.
  const v6 = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return LOOPBACK_IPV6.has(v6);
}
