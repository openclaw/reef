import { canonicalBytes, canonicalJson, fromBase64, fromBase64url, parseHandleEpoch, type Envelope } from "@openclaw/reef-protocol";

const encoder = new TextEncoder();
const FRIEND_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", ownedBuffer(bytes))), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomFriendCode(
  length = 6,
  rng: (length: number) => Uint8Array = (size) => crypto.getRandomValues(new Uint8Array(new ArrayBuffer(size))),
): string {
  return Array.from(rng(length), (byte) => FRIEND_CODE_ALPHABET[byte & 31]).join("");
}

export async function verifyEd25519(publicKey: string, signature: string, message: Uint8Array, urlSafe = true): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", ownedBuffer(fromBase64url(publicKey)), { name: "Ed25519" }, false, ["verify"]);
    const sig = urlSafe ? fromBase64url(signature) : fromBase64(signature);
    return await crypto.subtle.verify("Ed25519", key, ownedBuffer(sig), ownedBuffer(message));
  } catch {
    return false;
  }
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

export async function verifyEnvelopeForRelay(value: unknown, senderPublicKey: string): Promise<boolean> {
  if (!isEnvelope(value)) return false;
  const { sig, ...unsigned } = value;
  return verifyEd25519(senderPublicKey, sig, canonicalBytes(unsigned), false);
}

export function canonicalSize(value: unknown): number {
  return encoder.encode(canonicalJson(value)).byteLength;
}

function isEnvelope(value: unknown): value is Envelope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = ["v", "id", "from", "to", "ts", "epk", "n", "ct", "sig"];
  if (Object.keys(record).length !== keys.length || !keys.every((key) => Object.hasOwn(record, key))) return false;
  if (record.v !== 1 || typeof record.id !== "string" || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(record.id)) return false;
  if (typeof record.from !== "string" || typeof record.to !== "string" || typeof record.ts !== "number" || !Number.isSafeInteger(record.ts) || record.ts < 0) return false;
  if (typeof record.epk !== "string" || typeof record.n !== "string" || typeof record.ct !== "string" || typeof record.sig !== "string") return false;
  if (record.from.length > 80 || record.to.length > 80 || record.epk.length > 46 || record.n.length > 18 || record.ct.length > 44_752 || record.sig.length > 90) return false;
  try {
    parseHandleEpoch(record.from);
    parseHandleEpoch(record.to);
    fromBase64(record.ct);
    return fromBase64(record.epk).length === 32 && fromBase64(record.n).length === 12 && fromBase64(record.sig).length === 64;
  } catch {
    return false;
  }
}
