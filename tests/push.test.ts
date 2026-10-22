import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mock, test } from "node:test";
import { evolvePet } from "../src/lib/game";
import { browserPushOwnedByAccount, enrollBrowserPush } from "../src/components/pwa-controls";
import {
  cronAuthorized, isAllowedPushEndpoint, parsePushSubscription, petNeedsCare, readPushBody,
} from "../src/lib/push";

const token = "a".repeat(32);
const endpoint = `https://fcm.googleapis.com/fcm/send/${token}`;

function browserFixture() {
  let unsubscribes = 0;
  let subscribes = 0;
  const keys = subscription().keys;
  const item = (url: string) => ({
    endpoint: url,
    toJSON: () => ({ endpoint: url, keys }),
    unsubscribe: async () => { unsubscribes++; return true; },
  }) as unknown as PushSubscription;
  const original = item(endpoint);
  const fresh = item(endpoint + "-rotated");
  const registration = {
    pushManager: {
      getSubscription: async () => original,
      subscribe: async () => { subscribes++; return fresh; },
    },
  } as unknown as ServiceWorkerRegistration;
  return { original, fresh, registration, unsubscribes: () => unsubscribes, subscribes: () => subscribes };
}

function subscription() {
  const curve = createECDH("prime256v1");
  curve.generateKeys();
  return {
    endpoint,
    keys: {
      p256dh: curve.getPublicKey().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
  };
}

test("account switches reconcile ownership without enrollment; explicit opt-in rotates rather than transfers", async () => {
  const browser = browserFixture();
  const owners = new Map([[browser.original.endpoint, "account-a"]]);
  const originalFetch = globalThis.fetch;
  let account = "account-a";
  const methods: string[] = [];
  globalThis.fetch = async (_url, init) => {
    assert.equal(init?.credentials, "same-origin");
    assert.equal(new Headers(init?.headers).get("x-push-account"), account);
    const method = init?.method ?? "GET";
    methods.push(method);
    if (method === "GET") {
      assert.equal(init?.cache, "no-store");
      return Response.json({
        accountId: account,
        endpoints: [...owners].filter(([, owner]) => owner === account).map(([url]) => url),
      });
    }
    assert.equal(method, "POST", "another account's subscription must never be deleted");
    const body = JSON.parse(String(init?.body));
    if (owners.has(body.endpoint) && owners.get(body.endpoint) !== account)
      return Response.json({ code: "endpoint_owned" }, { status: 409 });
    owners.set(body.endpoint, account);
    return Response.json({ message: "Saved" });
  };
  try {
    const signal = new AbortController().signal;
    assert.equal(await browserPushOwnedByAccount(browser.registration, signal, account), true);
    account = "account-b";
    assert.equal(await browserPushOwnedByAccount(browser.registration, signal, account), false);
    assert.deepEqual(methods, ["GET", "GET"]);
    assert.equal(browser.subscribes(), 0);
    assert.equal(browser.unsubscribes(), 0);
    await enrollBrowserPush(browser.registration, subscription().keys.p256dh, () => {}, signal, account);
    assert.deepEqual(methods, ["GET", "GET", "POST", "POST"]);
    assert.equal(browser.subscribes(), 1);
    assert.equal(browser.unsubscribes(), 1);
    assert.equal(owners.get(browser.original.endpoint), "account-a");
    assert.equal(owners.get(browser.fresh.endpoint), "account-b");
  } finally { globalThis.fetch = originalFetch; }
});

test("ownership cannot be confirmed for a different authenticated account", async () => {
  const browser = browserFixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ accountId: "account-b", endpoints: [browser.original.endpoint] });
  try {
    assert.equal(await browserPushOwnedByAccount(browser.registration, new AbortController().signal, "account-a"), false);
    assert.equal(browser.subscribes(), 0);
    assert.equal(browser.unsubscribes(), 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("device limits and account changes never rotate an existing subscription", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const accountChanged of [false, true]) {
      const browser = browserFixture();
      let current = true;
      globalThis.fetch = async () => {
        if (accountChanged) current = false;
        return Response.json({ code: accountChanged ? "endpoint_owned" : "device_limit" }, { status: 409 });
      };
      await assert.rejects(() => enrollBrowserPush(browser.registration, subscription().keys.p256dh,
        () => { if (!current) throw new Error("Account changed"); }, new AbortController().signal));
      assert.equal(browser.subscribes(), 0);
      assert.equal(browser.unsubscribes(), 0);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("failed enrollment revokes only the newly created browser subscription", async () => {
  const browser = browserFixture();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1
    ? Response.json({ code: "endpoint_owned" }, { status: 409 })
    : Response.json({ message: "Unavailable" }, { status: 503 });
  try {
    await assert.rejects(() => enrollBrowserPush(browser.registration, subscription().keys.p256dh,
      () => {}, new AbortController().signal));
    assert.equal(browser.subscribes(), 1);
    assert.equal(browser.unsubscribes(), 2, "old browser subscription and failed new subscription are revoked");
  } finally { globalThis.fetch = originalFetch; }
});

test("push ownership API scopes reads and mutations to the authenticated account", async () => {
  const authNext = createRequire(import.meta.url)("next-auth/next");
  const { db } = await import("../src/lib/db");
  const { GET, POST, DELETE } = await import("../src/app/api/push/route");
  const originalUrl = process.env.NEXTAUTH_URL;
  process.env.NEXTAUTH_URL = "https://pets.example";
  let account: string | null = "account-a";
  const item = subscription();
  const records = [{ ...item, userId: "account-a", id: "original", ...item.keys }];
  const original = {
    findUser: db.user.findUnique, queryRaw: db.$queryRaw,
    findSubscriptions: db.pushSubscription.findMany, deleteSubscriptions: db.pushSubscription.deleteMany,
    transaction: db.$transaction,
  };
  const auth = mock.method(authNext, "getServerSession", async () => account
    ? { user: { id: account, sessionVersion: 0 } } : null);
  const user = mock.fn(async () => ({
    id: account, blocked: false, emailVerified: new Date(), sessionVersion: 0,
  }));
  const rate = mock.fn(async () => [{ hits: 1 }]);
  const reads = mock.fn(async (args: { where: { userId: string } }) =>
    records.filter((entry) => entry.userId === args.where.userId).map((entry) => ({ endpoint: entry.endpoint })));
  const deletes = mock.fn(async (args: { where: { userId: string; endpoint: string } }) => {
    const index = records.findIndex((entry) => entry.userId === args.where.userId && entry.endpoint === args.where.endpoint);
    if (index >= 0) records.splice(index, 1);
    return { count: index >= 0 ? 1 : 0 };
  });
  const transaction = mock.fn(async (action: (tx: object) => Promise<unknown>) => action({
    $queryRaw: async () => [{ one: 1 }],
    pushSubscription: { findUnique: async () => records[0] },
  }));
  db.user.findUnique = user as unknown as typeof db.user.findUnique;
  db.$queryRaw = rate as unknown as typeof db.$queryRaw;
  db.pushSubscription.findMany = reads as unknown as typeof db.pushSubscription.findMany;
  db.pushSubscription.deleteMany = deletes as unknown as typeof db.pushSubscription.deleteMany;
  db.$transaction = transaction as unknown as typeof db.$transaction;
  const request = (method = "GET", expected = account) => new Request("https://pets.example/api/push", {
    method,
    headers: {
      Origin: "https://pets.example", "Content-Type": "application/json",
      ...(expected ? { "X-Push-Account": expected } : {}),
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(item) }),
  });
  try {
    const first = await GET(request());
    assert.equal(first.status, 200);
    assert.match(first.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(first.headers.get("vary"), "Cookie");
    assert.deepEqual(await first.json(), { accountId: "account-a", endpoints: [item.endpoint] });
    account = "account-b";
    assert.deepEqual(await (await GET(request())).json(), { accountId: "account-b", endpoints: [] });
    const stale = await POST(request("POST", "account-a"));
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, "account_changed");
    const attempt = await POST(request("POST"));
    assert.equal(attempt.status, 409);
    assert.equal((await attempt.json()).code, "endpoint_owned");
    assert.equal((await DELETE(request("DELETE"))).status, 200);
    assert.equal(records[0].userId, "account-a");
    assert.equal(records.length, 1, "the other account's endpoint is never transferred or deleted");
    account = null;
    assert.equal((await GET(request())).status, 401);
    assert.equal(reads.mock.callCount(), 2);
  } finally {
    auth.mock.restore();
    db.user.findUnique = original.findUser;
    db.$queryRaw = original.queryRaw;
    db.pushSubscription.findMany = original.findSubscriptions;
    db.pushSubscription.deleteMany = original.deleteSubscriptions;
    db.$transaction = original.transaction;
    if (originalUrl === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = originalUrl;
  }
});

test("push endpoints permit only exact HTTPS provider hosts and paths", () => {
  for (const value of [
    endpoint,
    `https://updates.push.services.mozilla.com/wpush/v2/${token}`,
    `https://web.push.apple.com/Q${token}`,
  ]) assert.equal(isAllowedPushEndpoint(value), true, value);

  for (const value of [
    undefined, null, "", "not a URL", "https://127.0.0.1/private", "https://[::1]/private",
    "https://169.254.169.254/latest/meta-data/",
    `http://fcm.googleapis.com/fcm/send/${token}`,
    `https://fcm.googleapis.com:443/fcm/send/${token}`,
    `https://fcm.googleapis.com:8443/fcm/send/${token}`,
    `https://attacker@fcm.googleapis.com/fcm/send/${token}`,
    `https://fcm.googleapis.com@evil.example/fcm/send/${token}`,
    `https://fcm.googleapis.com.evil.example/fcm/send/${token}`,
    `https://sub.fcm.googleapis.com/fcm/send/${token}`,
    `https://fcm.googleapis.com./fcm/send/${token}`,
    `https://FCM.GOOGLEAPIS.COM/fcm/send/${token}`,
    `https://fcm.googleapis.com/redirect/${token}`,
    `https://fcm.googleapis.com/fcm/send/../${token}`,
    `https://fcm.googleapis.com/fcm/send/%61${token}`,
    `https://fcm.googleapis.com/fcm/send/${token}?redirect=https://localhost`,
    `https://fcm.googleapis.com/fcm/send/${token}#fragment`,
    `https://web.push.apple.com/untrusted/${token}`,
    `https://updates.push.services.mozilla.com/wpush/v2/${"a".repeat(2300)}`,
  ]) assert.equal(isAllowedPushEndpoint(value), false, String(value));
});

test("push keys require canonical base64url, a 65-byte P-256 point, and 16-byte auth", () => {
  const valid = subscription();
  assert.deepEqual(parsePushSubscription(valid), {
    endpoint, p256dh: valid.keys.p256dh, auth: valid.keys.auth,
  });
  assert.ok(parsePushSubscription({
    ...valid, keys: { p256dh: valid.keys.p256dh + "=", auth: valid.keys.auth + "==" },
  }));
  for (const size of [0, 15, 17, 64]) {
    assert.equal(parsePushSubscription({
      ...valid, keys: { ...valid.keys, auth: randomBytes(size).toString("base64url") },
    }), null);
  }
  for (const size of [0, 33, 64, 66]) {
    assert.equal(parsePushSubscription({
      ...valid, keys: { ...valid.keys, p256dh: randomBytes(size).toString("base64url") },
    }), null);
  }
  const invalidPoint = Buffer.alloc(65);
  invalidPoint[0] = 4;
  assert.equal(parsePushSubscription({
    ...valid, keys: { ...valid.keys, p256dh: invalidPoint.toString("base64url") },
  }), null);
  for (const auth of [null, 42, "a+/invalid=", "not base64", valid.keys.auth + "==="]) {
    assert.equal(parsePushSubscription({ ...valid, keys: { ...valid.keys, auth } }), null);
  }
  for (const value of [null, {}, { endpoint }, { ...valid, keys: null }, { ...valid, endpoint: "https://localhost/" }])
    assert.equal(parsePushSubscription(value), null);
});

test("cron authentication fails closed and requires an exact bearer token", () => {
  const secret = randomBytes(32).toString("hex");
  const bearer = ["Bearer", secret].join(" ");
  assert.equal(cronAuthorized(bearer, secret), true);
  for (const missing of [undefined, "", "short"])
    assert.equal(cronAuthorized(bearer, missing), false);
  for (const value of [null, "", secret, bearer + "x", "bearer " + secret, "Bearer  " + secret])
    assert.equal(cronAuthorized(value, secret), false);
});

function jsonRequest(body: string, extraHeaders: Record<string, string> = {}) {
  return new Request("https://pets.example/api/push", {
    method: "POST", headers: { "Content-Type": "application/json", ...extraHeaders }, body,
  });
}

test("push JSON body accepts at most 4096 bytes and rejects invalid metadata or JSON", async () => {
  const valid = subscription();
  assert.deepEqual(await readPushBody(jsonRequest(JSON.stringify(valid))), valid);
  assert.equal(await readPushBody(jsonRequest(JSON.stringify("a".repeat(4094)))), "a".repeat(4094));
  for (const request of [
    jsonRequest("a".repeat(4097)),
    jsonRequest("{}", { "content-length": "4097" }),
    jsonRequest("{}", { "content-length": "-1" }),
    jsonRequest("{}", { "content-length": "not-a-number" }),
    jsonRequest("{}", { "Content-Type": "text/plain" }),
    jsonRequest("{invalid"),
    new Request("https://pets.example/api/push", { method: "POST", headers: { "Content-Type": "application/json" } }),
  ]) await assert.rejects(() => readPushBody(request));
});

test("streamed body size uses actual bytes, not a spoofed Content-Length", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("a".repeat(2048)));
      controller.enqueue(new TextEncoder().encode("b".repeat(2049)));
    },
    cancel() { cancelled = true; },
  });
  const request = new Request("https://pets.example/api/push", {
    method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "1" },
    body, duplex: "half",
  } as RequestInit & { duplex: "half" });
  await assert.rejects(() => readPushBody(request));
  assert.equal(cancelled, true);
  // The text length is small enough, but the encoded UTF-8 byte length is not.
  await assert.rejects(() => readPushBody(jsonRequest(JSON.stringify("🐱".repeat(1100)))));
});

test("neglect uses shared evolution including future timestamps and the 48-hour cap", () => {
  const now = new Date("2026-10-22T00:00:00Z");
  for (const hours of [-10, 0, 1, 12, 24, 48, 72, 1000]) {
    for (const hunger of [0, 30, 31, 80, 100]) {
      for (const happiness of [0, 31, 80]) {
        for (const energy of [0, 31, 80]) {
          for (const cleanliness of [0, 31, 80]) {
            const pet = {
              hunger, happiness, energy, cleanliness,
              updatedAt: new Date(now.getTime() - hours * 3_600_000),
            };
            const current = evolvePet(pet, pet.updatedAt, now);
            assert.equal(petNeedsCare(pet, now),
              Math.min(current.hunger, current.happiness, current.energy, current.cleanliness) <= 30);
          }
        }
      }
    }
  }
  const pet = { hunger: 100, happiness: 100, energy: 100, cleanliness: 100, updatedAt: now };
  assert.equal(petNeedsCare(pet, now), false);
  assert.equal(petNeedsCare({ ...pet, hunger: 30 }, now), true);
  assert.deepEqual(
    evolvePet(pet, new Date(now.getTime() - 72 * 3_600_000), now),
    evolvePet(pet, new Date(now.getTime() - 48 * 3_600_000), now),
  );
});

test("PostgreSQL cron filters before its cap, rotates owners fairly, and reserves once per day", {
  skip: process.env.PUSH_INTEGRATION_TEST !== "1",
}, async () => {
  const { db } = await import("../src/lib/db");
  const { GET } = await import("../src/app/api/cron/notify/route");
  const { default: webPush } = await import("web-push");
  const prefix = `push-test-${randomBytes(8).toString("hex")}`;
  const userIds: string[] = [];
  const needy = new Set<string>();
  const overdue = new Set<string>();
  const delivered = new Set<string>();
  let duplicateAttempts = 0;
  const originalSend = webPush.sendNotification;
  const environment = ["CRON_SECRET", "NEXT_PUBLIC_VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const;
  const previous = Object.fromEntries(environment.map((key) => [key, process.env[key]]));
  const vapid = webPush.generateVAPIDKeys();
  process.env.CRON_SECRET = randomBytes(32).toString("hex");
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = vapid.publicKey;
  process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
  process.env.VAPID_SUBJECT = "mailto:push-test@example.com";
  const request = () => new Request("https://pets.example/api/cron/notify", {
    headers: { authorization: ["Bearer", process.env.CRON_SECRET].join(" ") },
  });
  webPush.sendNotification = async (item) => {
    if (delivered.has(item.endpoint)) duplicateAttempts++;
    delivered.add(item.endpoint);
    return { statusCode: 201, body: "", headers: {} };
  };
  try {
    assert.equal(await db.user.count(), 0, "Push integration requires an empty isolated database");
    const now = new Date();
    const healthyUpdatedAt = new Date(now.getTime() - 3_600_000);
    for (let index = 0; index < 48; index++) {
      const needsCare = index < 25;
      const blocked = index === 46;
      const unverified = index === 47;
      const item = subscription();
      const pushEndpoint = `${endpoint}${prefix}-${index}`;
      const user = await db.user.create({
        data: {
          email: `${prefix}-${index}@example.com`,
          passwordHash: "integration-only-not-a-password-hash",
          blocked,
          emailVerified: unverified ? null : now,
          pet: {
            create: {
              name: "Integration pet", hunger: needsCare || blocked || unverified ? 10 : 100,
              happiness: 100, energy: 100, cleanliness: 100,
              updatedAt: needsCare || blocked || unverified ? now : healthyUpdatedAt,
            },
          },
          pushSubscriptions: {
            create: {
              endpoint: pushEndpoint, ...item.keys,
              lastNotifiedAt: needsCare
                ? new Date(now.getTime() - (index < 20 ? 2 : 7) * 86_400_000)
                : null,
            },
          },
        },
      });
      userIds.push(user.id);
      if (needsCare) needy.add(pushEndpoint);
      if (needsCare && index >= 20) overdue.add(pushEndpoint);
    }
    const first = await GET(request());
    assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));
    assert.deepEqual(await first.json(), { sent: 20 });
    for (const item of overdue) assert.ok(delivered.has(item), "oldest notifications get priority");
    for (const item of delivered) assert.ok(needy.has(item), "healthy, blocked and unverified owners are excluded");
    const rest = await Promise.all([GET(request()), GET(request())]);
    assert.ok(rest.every((response) => response.status === 200));
    assert.equal(delivered.size, 25);
    assert.deepEqual(delivered, needy);
    assert.deepEqual(await (await GET(request())).json(), { sent: 0 });
    assert.equal(duplicateAttempts, 0, "an endpoint cannot be notified twice today");
  } finally {
    webPush.sendNotification = originalSend;
    for (const key of environment) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await db.rateLimit.deleteMany({
      where: { key: { in: userIds.map((id) => `push-notify:${id}`) } },
    });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.$disconnect();
  }
});
