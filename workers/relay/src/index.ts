import {
  canonicalSiteRedirect as relayCanonicalSiteRedirect,
  createRelayApp,
  type EmailMessage,
  type EmailSender,
  type RelayConfig,
} from "@openclaw/reef-relay-core";
import { D1RelayStore } from "./d1-store.js";
import { DurableObjectMailboxes } from "./do-mailboxes.js";
import { Mailbox } from "./mailbox.js";

export { Mailbox };

const CONFIG: RelayConfig = {
  publicOrigin: "https://reefwire.ai",
  emailFrom: "hello@reefwire.ai",
  developmentMode: false,
  canonicalSiteHost: "reefwire.ai",
  redirectHosts: new Set([
    "reefwire.dev",
    "reefwire.io",
    "reef.openclaw.ai",
    "www.reefwire.ai",
    "reef-relay.services-91b.workers.dev",
  ]),
};

class LogEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<void> {
    console.log(JSON.stringify({ event: "magic_link", email: message.to, link: magicLink(message.text) }));
  }
}

class CloudflareEmailSender implements EmailSender {
  constructor(private readonly binding: SendEmail) {}

  async send(message: EmailMessage): Promise<void> {
    await this.binding.send(message);
  }
}

export function canonicalSiteRedirect(request: Request): Response | undefined {
  return relayCanonicalSiteRedirect(request, CONFIG);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const mailboxes = new DurableObjectMailboxes(env.MAILBOX);
    return createRelayApp({
      store: new D1RelayStore(env.DB),
      mailboxes,
      email: env.DEV_MODE === "1" || !env.EMAIL ? new LogEmailSender() : new CloudflareEmailSender(env.EMAIL),
      assets: env.ASSETS,
      config: { ...CONFIG, developmentMode: env.DEV_MODE === "1" },
      clientIp: (incoming) => incoming.headers.get("CF-Connecting-IP") ?? "unknown",
      connectWebSocket: (handle, incoming) => mailboxes.connect(handle, incoming),
    }).fetch(request);
  },
} satisfies ExportedHandler<Env>;

function magicLink(text: string): string | undefined {
  return /https:\/\/\S+/.exec(text)?.[0];
}
