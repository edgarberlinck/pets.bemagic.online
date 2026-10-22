import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { db } from "../src/lib/db";
import { createVerificationToken, hashPassword, hashToken } from "../src/lib/account-security";
import { consumeRateLimit } from "../src/lib/rate-limit";
import { POST as register } from "../src/app/api/auth/register/route";
import { POST as resend } from "../src/app/api/auth/resend/route";
import { GET as verify, POST as activate } from "../src/app/api/auth/verify/route";
import { authOptions } from "../src/lib/auth";
import type { CredentialsConfig } from "next-auth/providers/credentials";

test("PostgreSQL registration, verification, retry and durable limit integration", {
  skip: process.env.BACKEND_INTEGRATION_TEST !== "1",
}, async () => {
  const suffix = randomBytes(8).toString("hex");
  const email = `backend-test-${suffix}@example.com`;
  const rateKey = `backend-test:${suffix}`;
  const previousUrl = process.env.NEXTAUTH_URL;
  const previousMailKey = process.env.RESEND_API_KEY;
  const previousFrom = process.env.EMAIL_FROM;
  const previousVercel = process.env.VERCEL;
  const originalFetch = globalThis.fetch;
  const clientAddress = `2001:db8:${suffix.slice(0, 4)}:${suffix.slice(4, 8)}::1`;
  const clientHash = hashToken(clientAddress).slice(0, 40);
  process.env.NEXTAUTH_URL = "https://pets.example.com";
  process.env.VERCEL = "1";
  delete process.env.RESEND_API_KEY;
  const request = (body: object) => new Request("https://pets.example.com/api/auth/register", {
    method: "POST",
    headers: { origin: "https://pets.example.com", "content-type": "application/json", "x-vercel-forwarded-for": clientAddress },
    body: JSON.stringify(body),
  });
  const provider = authOptions.providers[0] as CredentialsConfig & { options: CredentialsConfig };
  const login = (password = "strong passphrase 123!") =>
    provider.options.authorize({ email, password }, {
      headers: { "x-vercel-forwarded-for": clientAddress }, body: {}, query: {}, method: "POST",
    });
  try {
    assert.equal((await register(new Request("https://pets.example.com", { method: "POST" }))).status, 403);
    assert.equal((await register(request({ email: "x@mailinator.com", password: "strong passphrase 123!" }))).status, 400);
    const first = await register(request({ email, password: "strong passphrase 123!" }));
    const duplicate = await register(request({ email, password: "different password 123!" }));
    assert.equal(first.status, 202);
    assert.equal(duplicate.status, 202);
    assert.deepEqual(await first.json(), await duplicate.json());
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    assert.equal(user.emailVerified, null);
    assert.equal(await login(), null, "unverified users cannot sign in");
    for (let index = 0; index < 6; index++) assert.equal((await resend(request({ email }))).status, 202);
    const resendLimit = await db.rateLimit.findUnique({ where: { key: `resend:email:${hashToken(email)}` } });
    assert.equal(resendLimit?.hits, 0);

    const token = createVerificationToken();
    await db.verificationToken.create({
      data: { userId: user.id, tokenHash: token.tokenHash, expiresAt: token.expiresAt },
    });
    process.env.RESEND_API_KEY = "test-only";
    process.env.EMAIL_FROM = "pets@example.com";
    globalThis.fetch = async () => new Response(null, { status: 503 });
    assert.equal((await resend(request({ email }))).status, 202);
    assert.equal(await db.verificationToken.count({ where: { userId: user.id } }), 1,
      "failed delivery deletes only the newly generated token");
    assert.ok(await db.verificationToken.findUnique({ where: { tokenHash: token.tokenHash } }),
      "earlier delivered links remain usable");
    globalThis.fetch = originalFetch;
    const response = await verify(new Request(`https://pets.example.com/api/auth/verify?token=${token.token}`));
    assert.equal(response.headers.get("location"), `https://pets.example.com/?verification=${token.token}`);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await db.user.findUniqueOrThrow({ where: { email } })).emailVerified, null,
      "opening a link never activates a preregistrant's password");
    assert.ok(await db.verificationToken.findUnique({ where: { tokenHash: token.tokenHash } }),
      "GET does not consume the verification token");
    assert.equal(await login(), null);
    const chosenPassword = "legitimate owner passphrase 456!";
    const expired = createVerificationToken();
    await db.verificationToken.create({
      data: { userId: user.id, tokenHash: expired.tokenHash, expiresAt: new Date(0) },
    });
    const expiredResponse = await activate(request({ token: expired.token, password: chosenPassword }));
    assert.equal(expiredResponse.status, 400);
    const genericInvalid = await expiredResponse.json();
    await db.user.update({ where: { id: user.id }, data: { blocked: true } });
    const blockedResponse = await activate(request({ token: token.token, password: chosenPassword }));
    assert.equal(blockedResponse.status, 400);
    assert.deepEqual(await blockedResponse.json(), genericInvalid);
    await db.user.update({ where: { id: user.id }, data: { blocked: false } });
    assert.equal((await activate(new Request("https://pets.example.com", {
      method: "POST", body: JSON.stringify({ token: token.token, password: chosenPassword }),
    }))).status, 403);
    assert.equal((await activate(request({ token: token.token, password: "short" }))).status, 400);
    const activated = await Promise.all([
      activate(request({ token: token.token, password: chosenPassword })),
      activate(request({ token: token.token, password: chosenPassword })),
    ]);
    assert.deepEqual(activated.map((result) => result.status).sort(), [200, 400],
      "only one concurrent activation can consume the token");
    const replay = await activate(request({ token: token.token, password: chosenPassword }));
    assert.equal(replay.status, 400);
    assert.deepEqual(await replay.json(), genericInvalid);
    assert.ok((await db.user.findUniqueOrThrow({ where: { email } })).emailVerified);
    assert.equal((await db.user.findUniqueOrThrow({ where: { email } })).sessionVersion, 1);
    assert.equal(await db.verificationToken.count({ where: { userId: user.id } }), 0,
      "activation invalidates every pending link for the account");
    assert.equal(await login(), null, "attacker's preregistration password is never activated");
    assert.equal((await login(chosenPassword))?.id, user.id, "only the email holder's chosen password can sign in");
    await db.user.update({ where: { id: user.id }, data: { blocked: true } });
    assert.equal(await login(chosenPassword), null, "blocked users cannot sign in");
    await db.user.update({ where: { id: user.id }, data: { blocked: false } });
    for (let index = 0; index < 5; index++) assert.equal(await login("incorrect password"), null);
    const flagged = await db.user.findUniqueOrThrow({ where: { email } });
    assert.equal(flagged.failedLoginCount, 5);
    assert.equal(flagged.suspiciousScore, 50);
    assert.deepEqual(flagged.suspiciousReasons, ["Repeated failed logins"]);

    const confirmed = createVerificationToken();
    await db.verificationToken.create({
      data: { userId: user.id, tokenHash: confirmed.tokenHash, expiresAt: confirmed.expiresAt },
    });
    const confirmedResponse = await activate(request({ token: confirmed.token, password: chosenPassword }));
    assert.equal(confirmedResponse.status, 400);
    assert.deepEqual(await confirmedResponse.json(), genericInvalid);
    assert.equal((await verify(new Request("https://pets.example.com/api/auth/verify?token=invalid"))).headers.get("location"),
      "https://pets.example.com/?verified=invalid");

    const results = await Promise.all(Array.from({ length: 12 }, () => consumeRateLimit(rateKey, 5, 60_000)));
    assert.equal(results.filter(Boolean).length, 5);
    assert.equal((await db.rateLimit.findUniqueOrThrow({ where: { key: rateKey } })).hits, 12);
    await db.rateLimit.update({ where: { key: rateKey }, data: { resetAt: new Date(0) } });
    assert.equal(await consumeRateLimit(rateKey, 5, 60_000), true);

    const pet = await db.pet.create({ data: { userId: user.id, name: "Test blob" } });
    assert.equal(pet.hunger, 80);
    assert.equal(pet.petColor, "#a78bfa");
    await db.pushSubscription.create({
      data: { userId: user.id, endpoint: `https://example.com/push/${suffix}`, p256dh: "public", auth: "test" },
    });
    await db.user.delete({ where: { id: user.id } });
    assert.equal(await db.pet.count({ where: { userId: user.id } }), 0);
    assert.equal(await db.pushSubscription.count({ where: { userId: user.id } }), 0);
    assert.equal(await db.verificationToken.count({ where: { userId: user.id } }), 0);
    // Hash generation also works in the same Node runtime as Prisma's adapter.
    assert.match(await hashPassword("integration password 123!"), /^scrypt-v1\$/);
  } finally {
    globalThis.fetch = originalFetch;
    await db.user.deleteMany({ where: { email } });
    await db.rateLimit.deleteMany({ where: { key: { in: [
      rateKey, `resend:email:${hashToken(email)}`, `login:email:${hashToken(email)}`,
      `register:${clientHash}`, `resend:${clientHash}`, `login:client:${clientHash}`, `verify-activate:${clientHash}`,
    ] } } });
    if (previousUrl === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = previousUrl;
    if (previousMailKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousMailKey;
    if (previousFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = previousFrom;
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
    await db.$disconnect();
  }
});
