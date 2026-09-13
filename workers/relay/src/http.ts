import { fromBase64url, parseHandleEpoch } from "@openclaw/reef-protocol";
import { LIMITS } from "./limits.js";
import type { RequestPolicy } from "./types.js";

export interface RequestData {
  bytes: Uint8Array;
  json: unknown;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function readRequestData(request: Request): Promise<RequestData> {
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(length) && length > LIMITS.requestBodyBytes) throw new HttpError(413, "request_too_large");
  if (request.method === "GET" || request.method === "DELETE") return { bytes: new Uint8Array(), json: undefined };
  const reader = request.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), json: undefined };
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > LIMITS.requestBodyBytes) {
      await reader.cancel();
      throw new HttpError(413, "request_too_large");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (bytes.byteLength === 0) return { bytes, json: undefined };
  try { return { bytes, json: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown }; }
  catch { throw new HttpError(400, "invalid_json"); }
}

export function exactObject(value: unknown, allowed: string[], optional = false): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_request");
  const record = value as Record<string, unknown>;
  if (!Object.keys(record).every((key) => allowed.includes(key))) throw new HttpError(400, "invalid_request");
  if (!optional && !allowed.every((key) => Object.hasOwn(record, key))) throw new HttpError(400, "invalid_request");
  return record;
}

export function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) throw new HttpError(400, "invalid_request");
  return value;
}

export function publicKeyField(record: Record<string, unknown>, field: string): string {
  const value = stringField(record, field);
  try { if (fromBase64url(value).length !== 32) throw new Error(); }
  catch { throw new HttpError(400, "invalid_public_key"); }
  return value;
}

export function policyField(value: unknown): RequestPolicy {
  if (value !== "code-only" && value !== "friends-of-friends" && value !== "open") throw new HttpError(400, "invalid_policy");
  return value;
}

export function isHandle(value: string): boolean {
  try { return parseHandleEpoch(`${value}#1`).handle === value; } catch { return false; }
}

export function validateHandle(value: string): void {
  if (!isHandle(value)) throw new HttpError(400, "invalid_handle");
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}
