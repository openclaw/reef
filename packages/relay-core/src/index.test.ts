import { describe, expect, it } from "vitest";
import { canonicalSiteRedirect, magicLinkMessage, randomFriendCode, type RelayConfig } from "./index.js";

const config: RelayConfig = {
  publicOrigin: "https://reef.example.com",
  emailFrom: "hello@reef.example.com",
  developmentMode: false,
  canonicalSiteHost: "reef.example.com",
  redirectHosts: new Set(["www.reef.example.com"]),
};

describe("shared relay core", () => {
  it("generates friend codes from the shared Crockford alphabet", () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);
    expect(randomFriendCode(32, () => bytes)).toBe("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
  });

  it("redirects configured site hosts without redirecting API traffic", () => {
    const site = canonicalSiteRedirect(new Request("https://www.reef.example.com/docs/?from=test"), config);
    expect(site?.status).toBe(301);
    expect(site?.headers.get("location")).toBe("https://reef.example.com/docs/?from=test");
    expect(canonicalSiteRedirect(new Request("https://www.reef.example.com/v1/friends"), config)).toBeUndefined();
  });

  it("builds the same magic-link message for every platform", () => {
    const message = magicLinkMessage("owner@example.com", "https://reef.example.com/welcome#token=abc", config.emailFrom);
    expect(message).toMatchObject({
      to: "owner@example.com",
      from: { email: "hello@reef.example.com", name: "Reef" },
      subject: "Your Reef sign-in link",
    });
    expect(message.html).toContain("https://reef.example.com/welcome#token=abc");
    expect(message.text).toContain("https://reef.example.com/welcome#token=abc");
  });
});
