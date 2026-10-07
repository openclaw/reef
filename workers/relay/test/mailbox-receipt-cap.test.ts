import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { seal } from "@openclaw/reef-protocol";
import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/limits.js";
import type { Mailbox } from "../src/mailbox.js";
import { becomeFriends, bodyOf, createUser, deviceApi, nextId, receiptFor } from "./helpers.js";

function mailbox(name: string) {
  return env.MAILBOX.get(env.MAILBOX.idFromName(name));
}

async function pull(box: ReturnType<typeof mailbox>, after = 0) {
  return await box.pull(after) as Awaited<ReturnType<Mailbox["pull"]>>;
}

describe("mailbox receipt cap", () => {
  const now = Math.floor(Date.now() / 1000);

  it("queues a message after 200 receipts", async () => {
    const box = mailbox("receipts-do-not-block-messages");
    for (let index = 0; index < 200; index += 1) {
      const receipt = await box.enqueue("peer", `receipt-${index}`, "receipt", "{}", now);
      expect(receipt.result).toBe("queued");
    }
    const message = await box.enqueue("peer", "message-1", "message", "{}", now);
    expect(message.result).toBe("queued");
    const firstPage = await pull(box);
    expect(firstPage.entries).toHaveLength(200);
    const nextPage = await pull(box, firstPage.cursor);
    expect(nextPage.entries).toMatchObject([{ id: "message-1", kind: "message" }]);
  });

  it("caps messages independently and deduplicates them when full", async () => {
    const box = mailbox("messages-still-cap-at-200");
    for (let index = 0; index < 200; index += 1) {
      const message = await box.enqueue("peer", `message-${index}`, "message", "{}", now);
      expect(message.result).toBe("queued");
    }
    const extra = await box.enqueue("peer", "message-200", "message", "{}", now);
    expect(extra.result).toBe("capacity");
    expect((await box.enqueue("peer", "message-0", "message", "{}", now)).result).toBe("duplicate");
    expect((await box.enqueue("peer", "receipt-1", "receipt", "{}", now)).result).toBe("queued");
  });

  it("rejects a receipt at capacity and keeps the unread oldest one", async () => {
    const box = mailbox("receipts-reject-at-capacity");
    for (let index = 0; index < 200; index += 1) {
      const receipt = await box.enqueue("peer", `receipt-${index}`, "receipt", "{}", now);
      expect(receipt.result).toBe("queued");
    }
    const extra = await box.enqueue("peer", "receipt-200", "receipt", "{}", now);
    expect(extra.result).toBe("capacity");
    expect((await box.enqueue("peer", "receipt-0", "receipt", "{}", now)).result).toBe("duplicate");
    const pulled = await pull(box);
    const receipts = pulled.entries.filter((entry) => entry.kind === "receipt");
    expect(receipts).toHaveLength(200);
    expect(pulled.entries[0]?.id).toBe("receipt-0");
    expect(pulled.entries.some((entry) => entry.id === "receipt-200")).toBe(false);
  });

  it("retries the cached signed acknowledgement after receipt retention frees capacity", async () => {
    const sender = await createUser("receipt-sender");
    const recipient = await createUser("receipt-recipient");
    await becomeFriends(sender, recipient);
    const senderBox = mailbox(sender.handle);
    for (let index = 0; index < 200; index += 1) {
      expect((await senderBox.enqueue(recipient.handle, `old-${index}`, "receipt", "{}", now)).result).toBe("queued");
    }
    const id = nextId();
    const envelope = seal({
      id, from: `${sender.handle}#1`, to: `${recipient.handle}#1`, body: { text: "receipt retry" },
      senderSigningSecretKey: sender.identity.signing.secretKey,
      recipientEncryptionPublicKey: recipient.identity.encryption.publicKey,
    });
    expect((await deviceApi(sender, `/v1/mail/${recipient.handle}`, { method: "POST", body: envelope })).status).toBe(202);
    const receipt = receiptFor(recipient, id);
    const ackPath = `/v1/mail/${sender.handle}/ack`;
    const full = await deviceApi(recipient, ackPath, { method: "POST", body: { id, receipt } });
    expect(full.status).toBe(429);
    expect(await full.json()).toMatchObject({ error: "mailbox_full" });
    expect((await pull(mailbox(recipient.handle))).entries).toEqual([]);
    expect((await pull(senderBox)).entries).toHaveLength(200);

    await runInDurableObject(senderBox, async (_instance, state) => {
      state.storage.sql.exec("UPDATE entries SET ts = ? WHERE kind = 'receipt'", now - LIMITS.envelopeRetentionSeconds);
    });
    expect(await runDurableObjectAlarm(senderBox)).toBe(true);
    const retried = await deviceApi(recipient, ackPath, { method: "POST", body: { id, receipt } });
    expect(retried.status).toBe(200);
    expect(await bodyOf(retried)).toEqual({ result: "cached", receipt });
    const inbox = await pull(senderBox);
    expect(inbox.entries).toMatchObject([{ id, kind: "receipt", receipt }]);
    expect((await deviceApi(recipient, ackPath, { method: "POST", body: { id, receipt } })).status).toBe(200);
    expect((await pull(senderBox)).entries).toHaveLength(1);
  });
});
