import type { MessageBody } from "./envelope.js";
import type { SignedReceipt } from "./receipts.js";

export interface ReplayRecord {
  envelopeHash: string;
  state: "available" | "in_flight" | "completed" | "consumed";
  receipt?: SignedReceipt;
  body?: MessageBody;
}

export function replayKey(peer: string, id: string): string {
  return `${peer}\n${id}`;
}

export function validateCompletion(receipt: SignedReceipt, body: MessageBody | undefined): void {
  if ((receipt.status === "accepted") !== (body !== undefined)) {
    throw new Error("accepted replay completion requires body; rejected completion forbids body");
  }
}
