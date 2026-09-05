import { describe, expect, it } from "vitest";
import { isLoopbackHost } from "../../src/extension/loopback.js";

describe("isLoopbackHost", () => {
  it("accepts the IPv4 loopback range 127.0.0.0/8", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.0.0.0")).toBe(true);
    expect(isLoopbackHost("127.255.255.255")).toBe(true);
  });

  it("rejects non-loopback IPv4 addresses", () => {
    expect(isLoopbackHost("127.0.0.0.1")).toBe(false); // too many octets
    expect(isLoopbackHost("192.168.1.1")).toBe(false);
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("8.8.8.8")).toBe(false);
  });

  it("rejects out-of-range octets under a 127 prefix", () => {
    expect(isLoopbackHost("127.999.999.999")).toBe(false);
    expect(isLoopbackHost("127.0.0.256")).toBe(false);
  });

  it("accepts localhost and .localhost subdomains (RFC 6761)", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("foo.localhost")).toBe(true);
  });

  it("does not treat a hostname that merely contains localhost as loopback", () => {
    expect(isLoopbackHost("notlocalhost")).toBe(false);
    expect(isLoopbackHost("localhost.evil.example")).toBe(false);
  });

  it("accepts the IPv6 loopback ::1 with or without brackets", () => {
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("0:0:0:0:0:0:0:1")).toBe(true);
  });

  it("rejects non-loopback IPv6 addresses", () => {
    expect(isLoopbackHost("::")).toBe(false);
    expect(isLoopbackHost("2001:db8::1")).toBe(false);
    expect(isLoopbackHost("[2001:db8::1]")).toBe(false);
  });

  it("rejects empty or whitespace hostnames", () => {
    expect(isLoopbackHost("")).toBe(false);
    expect(isLoopbackHost("   ")).toBe(false);
  });
});
