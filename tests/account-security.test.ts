import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AccountBodyError, accountRisk, createVerificationToken, hashPassword, hashToken, isDisposableEmail,
  isSameOrigin, normalizeEmail, readAccountBody, trustedClientKey, validatePassword, verifyPassword,
} from "../src/lib/account-security";

test("email normalization rejects malformed addresses and normalizes case", () => {
  assert.equal(normalizeEmail(" Person@Example.COM "), "person@example.com");
  for (const value of [null, "", "a@b", "x@@example.com", ".a@example.com", "a..b@example.com",
    "a@-example.com", "a@example..com", "x".repeat(65) + "@example.com", "a@example.com\nbad"])
    assert.equal(normalizeEmail(value), null);
});

test("disposable domains include subdomains but not lookalike suffixes", () => {
  assert.equal(isDisposableEmail("x@mailinator.com"), true);
  assert.equal(isDisposableEmail("x@sub.mailinator.com"), true);
  assert.equal(isDisposableEmail("x@mailinator.com.example.com"), false);
  assert.equal(isDisposableEmail("x@example.com"), false);
});

test("passwords have bounded length, salts are random, hashes verify safely", async () => {
  for (const value of [null, "", "short", " ".repeat(20), "x".repeat(129)])
    assert.equal(validatePassword(value), false);
  assert.equal(validatePassword("long passphrase 🐱 123"), true);
  await assert.rejects(hashPassword("short"));
  const password = "A long secure passphrase 123!";
  const a = await hashPassword(password);
  const b = await hashPassword(password);
  assert.notEqual(a, b);
  assert.equal(a.includes(password), false);
  assert.equal(await verifyPassword(password, a), true);
  assert.equal(await verifyPassword("incorrect passphrase", a), false);
  assert.equal(await verifyPassword(null, a), false);
  assert.equal(await verifyPassword(password, "malformed"), false);
  assert.equal(await verifyPassword(password, a + "$extra"), false);
  assert.equal(await verifyPassword("x".repeat(129), a), false);
});

test("verification tokens are random, hashed and expire in one hour", () => {
  const before = Date.now();
  const first = createVerificationToken();
  const second = createVerificationToken();
  assert.match(first.token, /^[a-f0-9]{64}$/);
  assert.notEqual(first.token, second.token);
  assert.notEqual(first.tokenHash, first.token);
  assert.equal(hashToken(first.token), first.tokenHash);
  assert.ok(first.expiresAt.getTime() >= before + 3_600_000);
  assert.ok(first.expiresAt.getTime() <= Date.now() + 3_600_000);
});

test("risk flags are explainable and cumulative", () => {
  assert.deepEqual(accountRisk("normal@example.com"), { score: 0, reasons: [] });
  assert.equal(accountRisk("a123456@example.com").score, 15);
  assert.equal(accountRisk("123456" + "a".repeat(40) + "@example.com").reasons.length, 2);
});

test("only deployment-trusted client headers affect rate-limit identities", () => {
  const previous = process.env.VERCEL;
  try {
    delete process.env.VERCEL;
    const headers = new Headers({ "x-forwarded-for": "attacker", "x-vercel-forwarded-for": "203.0.113.1" });
    assert.equal(trustedClientKey(headers), "shared");
    process.env.VERCEL = "1";
    assert.equal(trustedClientKey(headers), hashToken("203.0.113.1").slice(0, 40));
    assert.equal(trustedClientKey(new Headers({ "x-forwarded-for": "attacker" })), "shared");
  } finally {
    if (previous === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previous;
  }
});

test("mutation origin uses configured URL, never spoofable host headers", () => {
  const previous = process.env.NEXTAUTH_URL;
  process.env.NEXTAUTH_URL = "https://pets.example.com";
  try {
    assert.equal(isSameOrigin(new Request("https://pets.example.com", { headers: { origin: "https://pets.example.com" } })), true);
    const invalidHeaders: Record<string, string>[] = [{}, { origin: "https://evil.example" }, { origin: "null" },
      { origin: "https://pets.example.com", "sec-fetch-site": "cross-site" }];
    for (const headers of invalidHeaders)
      assert.equal(isSameOrigin(new Request("https://pets.example.com", { headers })), false);
    delete process.env.NEXTAUTH_URL;
    assert.equal(isSameOrigin(new Request("https://pets.example.com", { headers: { origin: "https://pets.example.com" } })), false);
  } finally {
    if (previous === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = previous;
  }
});

test("account JSON reader accepts objects and rejects invalid JSON or non-object bodies", async () => {
  const request = (body: string) => new Request("https://pets.example", { method: "POST", body });
  assert.deepEqual(await readAccountBody(request('{"email":"pessoa@example.com"}')), { email: "pessoa@example.com" });
  for (const body of ["", "invalid", "[]", "null", '"text"', "12"])
    await assert.rejects(readAccountBody(request(body)), (error) => error instanceof AccountBodyError && error.status === 400);
});

test("account JSON reader limits actual UTF-8 bytes and rejects oversized Content-Length", async () => {
  const body = JSON.stringify({ value: "x".repeat(4084) });
  assert.equal(Buffer.byteLength(body), 4096);
  assert.equal((await readAccountBody(new Request("https://pets.example", { method: "POST", body }))).value,
    "x".repeat(4084));
  for (const init of [
    { body: JSON.stringify({ value: "🐱".repeat(1100) }) },
    { body: "{}", headers: { "content-length": "4097" } },
    { body: JSON.stringify({ value: "x".repeat(4096) }), headers: { "content-length": "1" } },
  ]) await assert.rejects(readAccountBody(new Request("https://pets.example", { method: "POST", ...init })),
    (error) => error instanceof AccountBodyError && error.status === 413);
});

test("account JSON reader cancels oversized streams rather than reading the entire upload", async () => {
  let reads = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(2048)); },
    cancel() { cancelled = true; },
  });
  const request = new Request("https://pets.example", {
    method: "POST", body, duplex: "half", headers: { "content-length": "1" },
  } as RequestInit & { duplex: "half" });
  await assert.rejects(readAccountBody(request), (error) => error instanceof AccountBodyError && error.status === 413);
  assert.equal(cancelled, true);
  assert.ok(reads <= 4);
});
