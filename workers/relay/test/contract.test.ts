import { SELF } from "cloudflare:test";
import { registerRelayContractTests } from "../../../packages/relay-core/test/contract.js";

registerRelayContractTests("Cloudflare", {
  baseUrl: "https://example.test",
  fetch: (request) => SELF.fetch(request),
});
