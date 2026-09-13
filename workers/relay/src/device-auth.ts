import { canonicalBytes } from "@openclaw/reef-protocol";
import { sha256Hex, verifyEd25519 } from "./crypto.js";
import { HttpError, isHandle, nowSeconds } from "./http.js";
import { LIMITS } from "./limits.js";
import { getHandle } from "./registry.js";
import type { DeviceIdentity } from "./types.js";

export async function deviceIdentity(request: Request, body: Uint8Array, env: Env): Promise<DeviceIdentity> {
  const url = new URL(request.url);
  const handle = (request.headers.get("x-reef-handle") ?? url.searchParams.get("handle") ?? "").toLowerCase();
  const tsRaw = request.headers.get("x-reef-ts") ?? url.searchParams.get("ts") ?? "";
  const signature = request.headers.get("x-reef-sig") ?? url.searchParams.get("sig") ?? "";
  const ts = Number(tsRaw);
  if (!isHandle(handle) || !Number.isSafeInteger(ts) || Math.abs(nowSeconds() - ts) > LIMITS.deviceClockSkewSeconds || signature.length > 128) {
    throw new HttpError(401, "invalid_device_signature");
  }
  const row = await getHandle(env.DB, handle);
  if (!row) throw new HttpError(401, "invalid_device_signature");
  const signedPath = canonicalSignedPath(url);
  const message = canonicalBytes({ method: request.method.toUpperCase(), path: signedPath, ts, bodySha256: await sha256Hex(body) });
  if (!await verifyEd25519(row.ed25519_pub, signature, message)) throw new HttpError(401, "invalid_device_signature");
  const replayKey = `${handle}:${ts}:${signature.slice(0, 24)}`;
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM request_replays WHERE expires < ?").bind(nowSeconds()),
      env.DB.prepare("INSERT INTO request_replays(replay_key, expires) VALUES (?, ?)").bind(replayKey, nowSeconds() + LIMITS.replayTtlSeconds),
    ]);
  } catch {
    throw new HttpError(409, "replayed_request");
  }
  return { handle, row };
}

function canonicalSignedPath(url: URL): string {
  const params = new URLSearchParams(url.search);
  params.delete("sig");
  params.delete("ts");
  params.delete("handle");
  const query = params.toString();
  return query ? `${url.pathname}?${query}` : url.pathname;
}
