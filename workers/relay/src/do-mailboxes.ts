import type { AcknowledgeResult, EnqueueResult, InboxEntry, InboxEntryKind, MailboxStore } from "@openclaw/reef-relay-core";

export class DurableObjectMailboxes implements MailboxStore {
  constructor(private readonly namespace: DurableObjectNamespace<import("./mailbox.js").Mailbox>) {}

  enqueue(handle: string, peer: string, id: string, kind: InboxEntryKind, payloadJson: string, now: number): Promise<EnqueueResult> {
    return this.stub(handle).enqueue(peer, id, kind, payloadJson, now);
  }

  pull(handle: string, after: number): Promise<{ entries: InboxEntry[]; cursor: number }> {
    return this.stub(handle).pull(after);
  }

  acknowledge(handle: string, peer: string, id: string, receiptJson: string, now: number): Promise<AcknowledgeResult> {
    return this.stub(handle).acknowledge(peer, id, receiptJson, now);
  }

  deletePeer(handle: string, peer: string): Promise<void> {
    return this.stub(handle).deletePeer(peer);
  }

  destroy(handle: string): Promise<void> {
    return this.stub(handle).destroy();
  }

  connect(handle: string, request: Request): Promise<Response> {
    return this.stub(handle).fetch(new Request("https://mailbox/connect", request));
  }

  private stub(handle: string) {
    return this.namespace.get(this.namespace.idFromName(handle));
  }
}
