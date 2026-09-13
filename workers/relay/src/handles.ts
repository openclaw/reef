import { verifyRotation, type SignedRotation } from "@openclaw/reef-protocol";
import { accountSession, type AccountSession } from "./account-auth.js";
import { deviceIdentity } from "./device-auth.js";
import { exactObject, HttpError, json, nowSeconds, policyField, publicKeyField, stringField, validateHandle, type RequestData } from "./http.js";
import { getHandle, mailbox, peerFromPair } from "./registry.js";
import type { HandleRow } from "./types.js";

export async function createHandle(value: unknown, session: AccountSession, env: Env): Promise<Response> {
  const body = exactObject(value, ["handle", "ed25519_pub", "x25519_pub", "request_policy"]);
  const handle = stringField(body, "handle").toLowerCase();
  validateHandle(handle);
  const ed25519 = publicKeyField(body, "ed25519_pub");
  const x25519 = publicKeyField(body, "x25519_pub");
  const policy = policyField(body.request_policy);
  try {
    await env.DB.prepare("INSERT INTO handles(handle, account_id, ed25519_pub, x25519_pub, key_epoch, request_policy, created) VALUES (?, ?, ?, ?, 1, ?, ?)")
      .bind(handle, session.accountId, ed25519, x25519, policy, nowSeconds()).run();
  } catch {
    throw new HttpError(409, "handle_unavailable");
  }
  return json({ handle, key_epoch: 1, request_policy: policy }, 201);
}

export async function listOwnHandles(session: AccountSession, env: Env): Promise<Response> {
  const rows = await env.DB.prepare("SELECT handle, ed25519_pub, x25519_pub, key_epoch, request_policy, created FROM handles WHERE account_id = ? ORDER BY handle")
    .bind(session.accountId).all<Omit<HandleRow, "account_id">>();
  return json({ handles: rows.results });
}

export async function rotateHandle(handle: string, data: RequestData, request: Request, bearer: string | undefined, env: Env): Promise<Response> {
  validateHandle(handle);
  const current = await getHandle(env.DB, handle);
  if (!current) throw new HttpError(404, "not_found");
  const body = exactObject(data.json, ["signedRotation", "recovery"], true);
  if (body.signedRotation !== undefined) {
    const device = await deviceIdentity(request, data.bytes, env);
    if (device.handle !== handle) throw new HttpError(403, "forbidden");
    const rotation = body.signedRotation as SignedRotation;
    if (!verifyRotation(rotation, current.ed25519_pub) || rotation.newEpoch !== current.key_epoch + 1) throw new HttpError(400, "invalid_rotation");
    const updated = await env.DB.prepare("UPDATE handles SET ed25519_pub = ?, x25519_pub = ?, key_epoch = ? WHERE handle = ? AND key_epoch = ? AND ed25519_pub = ?")
      .bind(rotation.newEd25519Pub, rotation.newX25519Pub, rotation.newEpoch, handle, current.key_epoch, current.ed25519_pub).run();
    if ((updated.meta.changes ?? 0) !== 1) throw new HttpError(409, "rotation_conflict");
    return json({ handle, key_epoch: rotation.newEpoch, recovery: false });
  }
  if (!bearer) throw new HttpError(401, "unauthorized");
  const session = await accountSession(request, env);
  if (session.accountId !== current.account_id) throw new HttpError(403, "forbidden");
  const recovery = exactObject(body.recovery, ["newEd25519Pub", "newX25519Pub"]);
  const ed25519 = publicKeyField(recovery, "newEd25519Pub");
  const x25519 = publicKeyField(recovery, "newX25519Pub");
  const nextEpoch = current.key_epoch + 1;
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE handles SET ed25519_pub = ?, x25519_pub = ?, key_epoch = ? WHERE handle = ? AND key_epoch = ? AND ed25519_pub = ?")
      .bind(ed25519, x25519, nextEpoch, handle, current.key_epoch, current.ed25519_pub),
    env.DB.prepare(`UPDATE friendships SET status = 'reapprove_required', reapprove_handle = ?
      WHERE (a_handle = ? OR b_handle = ?) AND status = 'active'
      AND EXISTS (SELECT 1 FROM handles WHERE handle = ? AND key_epoch = ? AND ed25519_pub = ?)`)
      .bind(handle, handle, handle, handle, nextEpoch, ed25519),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) throw new HttpError(409, "rotation_conflict");
  const peers = await env.DB.prepare("SELECT a_handle, b_handle FROM friendships WHERE reapprove_handle = ? AND status = 'reapprove_required'")
    .bind(handle).all<{ a_handle: string; b_handle: string }>();
  await mailbox(env, handle).destroy();
  await Promise.all(peers.results.map((pair) => mailbox(env, peerFromPair(pair.a_handle, pair.b_handle, handle)).deletePeer(handle)));
  return json({ handle, key_epoch: nextEpoch, recovery: true, reapproval_required: peers.results.length });
}
