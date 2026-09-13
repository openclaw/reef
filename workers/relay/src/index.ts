import { accountSession, authComplete, authStart, sessionToken } from "./account-auth.js";
import { deviceIdentity } from "./device-auth.js";
import { listFriends, mintCode, removeFriend, reportPeer, requestFriend, respondFriend } from "./friends.js";
import { createHandle, listOwnHandles, rotateHandle } from "./handles.js";
import { decodePathParameter, HttpError, json, readRequestData, type RequestData } from "./http.js";
import { LIMITS } from "./limits.js";
import { acknowledgeMail, connectMailbox, pullMail, sendMail } from "./mail.js";
import { consumeRate } from "./registry.js";
import { canonicalSiteRedirect } from "./site.js";
import type { DeviceIdentity } from "./types.js";

export { Mailbox } from "./mailbox.js";
export { canonicalSiteRedirect } from "./site.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(JSON.stringify({ event: "request_error", error: error instanceof Error ? error.message : String(error) }));
      return json({ error: "internal_error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/v1/")) {
    const redirect = canonicalSiteRedirect(request);
    return redirect ?? env.ASSETS.fetch(request);
  }
  const data = await readRequestData(request);

  if (request.method === "POST" && url.pathname === "/v1/auth/start") return authStart(data.json, request, env);
  if (request.method === "POST" && url.pathname === "/v1/auth/complete") return authComplete(data.json, env);
  if (request.method === "GET" && url.pathname === "/v1/auth/complete") return authComplete({ token: url.searchParams.get("token") }, env);
  if (request.method === "POST" && url.pathname === "/v1/handles") {
    const session = await accountSession(request, env);
    return createHandle(data.json, session, env);
  }
  if (request.method === "GET" && url.pathname === "/v1/handles") {
    const session = await accountSession(request, env);
    return listOwnHandles(session, env);
  }

  const rotationMatch = /^\/v1\/handles\/([^/]+)\/rotate$/.exec(url.pathname);
  if (request.method === "POST" && rotationMatch) return rotateHandle(decodePathParameter(rotationMatch[1]!), data, request, sessionToken(request), env);

  const handler = deviceRoute(request, url, data, env);
  if (!handler) throw new HttpError(404, "not_found");
  const device = await deviceIdentity(request, data.bytes, env);
  await consumeRate(env.DB, `global:${device.handle}`, 3600, LIMITS.globalHandlePerHour);
  return handler(device);
}

type DeviceHandler = (device: DeviceIdentity) => Promise<Response>;

function deviceRoute(request: Request, url: URL, data: RequestData, env: Env): DeviceHandler | undefined {
  if (request.method === "POST" && url.pathname === "/v1/friend-codes") return (device) => mintCode(device, env);
  if (request.method === "POST" && url.pathname === "/v1/friends/request") return (device) => requestFriend(data.json, device, env);
  if (request.method === "POST" && url.pathname === "/v1/friends/respond") return (device) => respondFriend(data.json, device, env);
  if (request.method === "GET" && url.pathname === "/v1/friends") return (device) => listFriends(device, env);

  const friendDelete = /^\/v1\/friends\/([^/]+)$/.exec(url.pathname);
  if (request.method === "DELETE" && friendDelete) return (device) => removeFriend(decodePathParameter(friendDelete[1]!), device, env);

  if (request.method === "GET" && url.pathname === "/v1/mail/ws") return (device) => connectMailbox(device, request, env);
  if (request.method === "GET" && url.pathname === "/v1/mail") return (device) => pullMail(url, device, env);
  const mailAck = /^\/v1\/mail\/([^/]+)\/ack$/.exec(url.pathname);
  if (request.method === "POST" && mailAck) return (device) => acknowledgeMail(decodePathParameter(mailAck[1]!), data.json, device, env);
  const mail = /^\/v1\/mail\/([^/]+)$/.exec(url.pathname);
  if (mail && request.method === "POST") return (device) => sendMail(decodePathParameter(mail[1]!), data.json, device, env);
  if (request.method === "POST" && url.pathname === "/v1/report") return (device) => reportPeer(data.json, device, env);
  return undefined;
}
