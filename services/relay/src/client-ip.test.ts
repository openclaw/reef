import { describe, expect, it } from "vitest";
import { parseTrustedProxies, resolveClientIp } from "./client-ip.js";

describe("trusted proxy client IP resolution", () => {
  it("ignores forwarded addresses from untrusted peers", () => {
    const proxies = parseTrustedProxies("10.42.0.10");
    expect(resolveClientIp("10.42.0.11", "203.0.113.7", proxies)).toBe("10.42.0.11");
  });

  it("accepts forwarded addresses from configured addresses and CIDRs", () => {
    const proxies = parseTrustedProxies("10.42.0.10,192.168.20.0/24,2001:db8::/32");
    expect(resolveClientIp("10.42.0.10", "203.0.113.7, 10.42.0.10", proxies)).toBe("203.0.113.7");
    expect(resolveClientIp("192.168.20.9", "198.51.100.4", proxies)).toBe("198.51.100.4");
    expect(resolveClientIp("2001:db8::10", "2001:db8:ffff::5", proxies)).toBe("2001:db8:ffff::5");
  });

  it("rejects malformed forwarded addresses and proxy configuration", () => {
    const proxies = parseTrustedProxies("10.42.0.10");
    expect(resolveClientIp("10.42.0.10", "spoofed", proxies)).toBe("10.42.0.10");
    expect(() => parseTrustedProxies("10.42.0.0/33")).toThrow("invalid address or CIDR");
    expect(() => parseTrustedProxies("not-an-address")).toThrow("invalid address or CIDR");
  });

  it("normalizes IPv4-mapped peer addresses before matching", () => {
    const proxies = parseTrustedProxies("10.42.0.0/24");
    expect(resolveClientIp("::ffff:10.42.0.10", "203.0.113.7", proxies)).toBe("203.0.113.7");
  });
});
