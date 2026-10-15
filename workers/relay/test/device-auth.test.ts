import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { createUser, makeDeviceRequest } from "./helpers.js";

describe("device replay protection", () => {
  it("rejects an actual duplicate without changing its public error", async () => {
    const user = await createUser("replay-conflict");
    const request = await makeDeviceRequest(user, "/v1/friends");
    const replay = request.clone();
    expect((await SELF.fetch(request)).status).toBe(200);
    const response = await SELF.fetch(replay.url, { method: replay.method, headers: replay.headers });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "replayed_request" });
  });

  it("reports a replay-store outage as a server failure", async () => {
    const user = await createUser("replay-outage");
    const request = await makeDeviceRequest(user, "/v1/friends");
    // Keep real signatures, handle lookup, and routing; fail only D1's batch
    // boundary to reproduce a transient storage error after authentication.
    const unavailableDB = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch") return async () => { throw new Error("D1_ERROR: Network connection lost."); };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const response = await worker.fetch(request, { ...env, DB: unavailableDB });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "internal_error" });
  });
});
