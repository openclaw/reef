import type { EmailMessage, EmailSender } from "@openclaw/reef-relay-core";
import nodemailer from "nodemailer";
import type { RelayNodeConfig } from "./config.js";

export function createEmailSender(config: RelayNodeConfig, log: (record: Record<string, unknown>) => void): EmailSender {
  if (config.developmentMode) {
    return {
      async send(message: EmailMessage): Promise<void> {
        log({ event: "magic_link", email: message.to, link: /https:\/\/\S+/.exec(message.text)?.[0] });
      },
    };
  }
  if (!config.smtp) throw new Error("SMTP is not configured");
  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    ...(config.smtp.user ? { auth: { user: config.smtp.user, pass: config.smtp.password ?? "" } } : {}),
  });
  return {
    async send(message: EmailMessage): Promise<void> {
      await transport.sendMail({ ...message, from: { address: message.from.email, name: message.from.name } });
    },
  };
}
