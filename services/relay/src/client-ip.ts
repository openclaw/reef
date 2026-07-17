import { BlockList, isIP } from "node:net";

export function parseTrustedProxies(value: string | undefined): BlockList {
  const proxies = new BlockList();
  for (const item of (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)) {
    const slash = item.lastIndexOf("/");
    const address = slash === -1 ? item : item.slice(0, slash);
    const family = isIP(address);
    const maxPrefix = family === 4 ? 32 : family === 6 ? 128 : 0;
    const prefixText = slash === -1 ? String(maxPrefix) : item.slice(slash + 1);
    const prefix = /^\d+$/.test(prefixText) ? Number(prefixText) : -1;
    if (family === 0 || prefix < 0 || prefix > maxPrefix) {
      throw new Error(`TRUSTED_PROXY_CIDRS contains invalid address or CIDR: ${item}`);
    }
    proxies.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
  }
  return proxies;
}

export function resolveClientIp(peerAddress: string | undefined, forwardedFor: string | null, trustedProxies: BlockList): string {
  const peer = normalizeAddress(peerAddress);
  const family = isIP(peer);
  const trusted = family !== 0 && trustedProxies.check(peer, family === 4 ? "ipv4" : "ipv6");
  if (trusted) {
    const forwarded = normalizeAddress(forwardedFor?.split(",")[0]?.trim());
    if (isIP(forwarded) !== 0) return forwarded;
  }
  return peer || "unknown";
}

function normalizeAddress(address: string | null | undefined): string {
  const value = address ?? "";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value)?.[1];
  return mapped && isIP(mapped) === 4 ? mapped : value;
}
