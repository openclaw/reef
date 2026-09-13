import { formatHandleEpoch, verifyReceipt, type Envelope, type SignedReceipt } from "@openclaw/reef-protocol";
import { canonicalSize, verifyEnvelopeForRelay } from "./crypto.js";
import { exactObject, HttpError, json, nowSeconds, stringField } from "./http.js";
import { LIMITS } from "./limits.js";
import { consumeRate, getHandle, mailbox, requireActiveFriend } from "./registry.js";
import type { DeviceIdentity } from "./types.js";

export async function sendMail(peer: string, value: unknown, device: DeviceIdentity, env: Env): Promise<Response> {
  const pair = await requireActiveFriend(peer, device.handle, env);
  if (value === null || value === undefined || typeof value !== "object") throw new HttpError(400, "invalid_envelope");
  let size: number;
  try {
    size = canonicalSize(value);
  } catch {
    throw new HttpError(400, "invalid_envelope");
  }
  if (size > LIMITS.envelopeBytes) throw new HttpError(413, "envelope_too_large");
  const envelope = value as Envelope;
  if (envelope.from !== formatHandleEpoch(device.handle, device.row.key_epoch)) throw new HttpError(400, "invalid_envelope_peers");
  const peerRow = await getHandle(env.DB, peer);
  if (!peerRow || envelope.to !== formatHandleEpoch(peer, peerRow.key_epoch)) throw new HttpError(400, "invalid_envelope_peers");
  if (!await verifyEnvelopeForRelay(value, device.row.ed25519_pub)) throw new HttpError(400, "invalid_envelope");
  const rateKey = pair.join("|");
  await consumeRate(env.DB, `mail-hour:${rateKey}`, 3600, LIMITS.mailPerPairHour);
  await consumeRate(env.DB, `mail-minute:${rateKey}`, 60, LIMITS.mailBurstPerMinute);
  const result = await mailbox(env, peer).enqueue(device.handle, envelope.id, "message", JSON.stringify(envelope), nowSeconds());
  if (result.result === "capacity") throw new HttpError(429, "mailbox_full");
  return json({ id: envelope.id, status: result.result }, result.result === "queued" ? 202 : 200);
}

export async function pullMail(url: URL, device: DeviceIdentity, env: Env): Promise<Response> {
  const afterRaw = url.searchParams.get("after") ?? "0";
  const after = Number(afterRaw);
  if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, "invalid_after");
  return json(await mailbox(env, device.handle).pull(after));
}

export async function connectMailbox(device: DeviceIdentity, request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "upgrade_required");
  const internal = new URL("https://mailbox/connect");
  return mailbox(env, device.handle).fetch(new Request(internal, request));
}

export async function acknowledgeMail(peer: string, value: unknown, device: DeviceIdentity, env: Env): Promise<Response> {
  await requireActiveFriend(peer, device.handle, env);
  const body = exactObject(value, ["id", "receipt"]);
  const id = stringField(body, "id");
  const receipt = body.receipt as SignedReceipt;
  if (receipt?.id !== id || !verifyReceipt(receipt, device.row.ed25519_pub)) throw new HttpError(400, "invalid_receipt");
  const result = await mailbox(env, device.handle).acknowledge(peer, id, JSON.stringify(receipt), nowSeconds());
  if (result.result === "missing") throw new HttpError(404, "not_found");
  const forwarded = await mailbox(env, peer).enqueue(device.handle, id, "receipt", result.receiptJson!, nowSeconds());
  if (forwarded.result === "capacity") throw new HttpError(429, "mailbox_full");
  return json({ result: result.result, receipt: result.receiptJson ? JSON.parse(result.receiptJson) as unknown : undefined });
}
