import { randomToken, sha256Hex } from "./crypto.js";
import { exactObject, HttpError, json, nowSeconds, stringField } from "./http.js";
import { LIMITS } from "./limits.js";
import { consumeRate } from "./registry.js";

export interface AccountSession {
  accountId: string;
}

const MAGIC_LINK_ORIGIN = "https://reefwire.ai";

export async function authStart(value: unknown, request: Request, env: Env): Promise<Response> {
  const body = exactObject(value, ["email"]);
  const email = stringField(body, "email").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "invalid_request");
  const now = nowSeconds();
  const emailHash = await sha256Hex(email);
  const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
  await consumeRate(env.DB, `auth-email:${emailHash}`, 3600, LIMITS.authStartsPerEmailHour);
  await consumeRate(env.DB, `auth-ip:${clientIp}`, 3600, LIMITS.authStartsPerIpHour);
  await env.DB.prepare("DELETE FROM auth_tokens WHERE expires < ? OR used = 1").bind(now).run();
  let account = await env.DB.prepare("SELECT id FROM accounts WHERE email = ? COLLATE NOCASE").bind(email).first<{ id: string }>();
  if (!account) {
    account = { id: crypto.randomUUID() };
    await env.DB.prepare("INSERT INTO accounts(id, email, email_hash, created) VALUES (?, ?, ?, ?)")
      .bind(account.id, email, emailHash, now).run();
  }
  const token = randomToken();
  await env.DB.prepare("INSERT INTO auth_tokens(token_hash, account_id, expires) VALUES (?, ?, ?)")
    .bind(await sha256Hex(token), account.id, now + LIMITS.magicTokenTtlSeconds).run();
  const link = `${MAGIC_LINK_ORIGIN}/welcome#token=${encodeURIComponent(token)}`;
  if (env.DEV_MODE === "1" || !env.EMAIL) {
    console.log(JSON.stringify({ event: "magic_link", email, link }));
  } else {
    await env.EMAIL.send({
      to: email,
      from: { email: "hello@reefwire.ai", name: "Reef" },
      subject: "Your Reef sign-in link",
      html: magicLinkHtml(link),
      text: `Sign in to Reef\n\nOpen this link to verify your email and continue setup:\n${link}\n\nThis link expires soon and can only be used once.`,
    });
  }
  return env.DEV_MODE === "1" ? json({ status: "sent", magicLink: link }) : json({ status: "sent" });
}

export async function authComplete(value: unknown, env: Env): Promise<Response> {
  const body = exactObject(value, ["token"]);
  const token = stringField(body, "token");
  const hash = await sha256Hex(token);
  const now = nowSeconds();
  const row = await env.DB.prepare("SELECT account_id FROM auth_tokens WHERE token_hash = ? AND used = 0 AND expires >= ?")
    .bind(hash, now).first<{ account_id: string }>();
  if (!row) throw new HttpError(401, "invalid_or_expired_token");
  const used = await env.DB.prepare("UPDATE auth_tokens SET used = 1 WHERE token_hash = ? AND used = 0").bind(hash).run();
  if ((used.meta.changes ?? 0) !== 1) throw new HttpError(401, "invalid_or_expired_token");
  const session = randomToken();
  await env.DB.prepare("INSERT INTO sessions(token_hash, account_id, expires, created) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(session), row.account_id, now + LIMITS.sessionTtlSeconds, now).run();
  return json({ session, expires: now + LIMITS.sessionTtlSeconds });
}

export async function accountSession(request: Request, env: Env): Promise<AccountSession> {
  const token = sessionToken(request);
  if (!token) throw new HttpError(401, "unauthorized");
  const row = await env.DB.prepare("SELECT account_id FROM sessions WHERE token_hash = ? AND expires >= ?")
    .bind(await sha256Hex(token), nowSeconds()).first<{ account_id: string }>();
  if (!row) throw new HttpError(401, "unauthorized");
  return { accountId: row.account_id };
}

export function sessionToken(request: Request): string | undefined {
  const authorization = request.headers.get("Authorization");
  const match = /^Bearer ([A-Fa-f0-9]{64})$/.exec(authorization ?? "");
  return match?.[1];
}

function magicLinkHtml(link: string): string {
  return `<!doctype html>
<html lang="en"><body style="margin:0;background:#061d24;color:#eaf4f2;font-family:Manrope,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:48px 24px">
<div style="border-top:1px solid rgba(168,213,204,.35);border-bottom:1px solid rgba(168,213,204,.35);padding:36px 0">
<p style="margin:0 0 18px;color:#a8d5cc;font:12px monospace;letter-spacing:.12em;text-transform:uppercase">Reef · guarded claw channel</p>
<h1 style="margin:0 0 18px;color:#eaf4f2;font:400 38px/1.05 Georgia,serif">Sign in to Reef</h1>
<p style="margin:0 0 28px;color:#a6bdb9;font-size:16px;line-height:1.65">Verify your email to continue setting up your Reef handle.</p>
<a href="${link}" style="display:inline-block;padding:14px 22px;background:#ff7a59;color:#10262b;text-decoration:none;font-size:14px;font-weight:700">Continue to Reef&nbsp;&nbsp;→</a>
<p style="margin:28px 0 0;color:#789792;font:12px/1.6 monospace">This link expires soon and can only be used once.</p>
</div>
</div></body></html>`;
}
