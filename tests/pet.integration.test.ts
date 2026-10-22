import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { db } from "../src/lib/db";
import { hashPassword, hashToken } from "../src/lib/account-security";

test("real HTTP credentials sessions enforce pet ownership, cooldown, concurrency and revocation", {
  skip: process.env.PET_HTTP_INTEGRATION !== "1",
  timeout: 60_000,
}, async () => {
  assert.ok(process.env.DATABASE_URL, "Use an isolated migrated PostgreSQL database.");
  const suffix = randomBytes(8).toString("hex");
  const port = process.env.PET_TEST_PORT ?? "3011";
  const base = `http://127.0.0.1:${port}`;
  const emails = [`pet-owner-${suffix}@example.com`, `pet-other-${suffix}@example.com`];
  const clientAddress = `2001:db8:${suffix.slice(0, 4)}:${suffix.slice(4, 8)}::2`;
  const clientHash = hashToken(clientAddress).slice(0, 40);
  const passphrase = randomBytes(24).toString("hex");
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", port], {
    env: {
      ...process.env,
      NEXTAUTH_URL: base,
      NEXTAUTH_SECRET: randomBytes(32).toString("hex"),
      VERCEL: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Drain logs without printing connection information or authentication material.
  server.stdout.resume();
  server.stderr.resume();
  const userIds: string[] = [];

  function client() {
    const cookies = new Map<string, string>();
    return async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("origin", base);
      headers.set("x-vercel-forwarded-for", clientAddress);
      if (cookies.size) headers.set("cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
      const response = await fetch(base + path, { ...init, headers, redirect: "manual" });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0];
        const index = pair.indexOf("=");
        cookies.set(pair.slice(0, index), pair.slice(index + 1));
      }
      return response;
    };
  }
  const owner = client();
  const other = client();
  const json = (method: string, body: object): RequestInit => ({
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const appearance = { name: "Nuvem", theme: "meadow", petColor: "#a78bfa", backgroundColor: "#ecfdf5" };
  async function login(request: ReturnType<typeof client>, email: string) {
    const csrf = await (await request("/api/auth/csrf")).json();
    const response = await request("/api/auth/callback/credentials", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken: csrf.csrfToken, email, password: passphrase, json: "true", callbackUrl: base }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).url, base);
    const session = await (await request("/api/auth/session")).json();
    assert.equal(session.user.email, email);
  }

  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) throw new Error("Isolated HTTP test server exited before readiness.");
      try {
        ready = (await fetch(base + "/api/auth/providers")).ok;
        if (ready) break;
      } catch { /* Wait for the isolated server to bind. */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, "HTTP test server must become ready.");
    for (const email of emails) {
      const user = await db.user.create({ data: { email, passwordHash: await hashPassword(passphrase), emailVerified: new Date() } });
      userIds.push(user.id);
    }
    assert.equal((await fetch(base + "/api/pet")).status, 401);
    assert.equal((await fetch(base + "/api/pet", json("POST", appearance))).status, 403);
    await login(owner, emails[0]);
    await login(other, emails[1]);

    const adopted = await owner("/api/pet", json("POST", { ...appearance, userId: userIds[1] }));
    assert.equal(adopted.status, 201);
    const { pet } = await adopted.json();
    assert.equal(pet.userId, userIds[0], "client-supplied owner cannot override authenticated owner");
    assert.equal((await owner("/api/pet", json("POST", appearance))).status, 409);
    assert.equal((await (await other("/api/pet")).json()).pet, null);
    assert.equal((await other("/api/pet", json("PATCH", { action: "feed", id: pet.id, userId: userIds[0] }))).status, 404);

    await db.pet.update({
      where: { id: pet.id },
      data: {
        hunger: 60, happiness: 60, energy: 60, cleanliness: 60,
        updatedAt: new Date(Date.now() - 3_600_000), lastActionAt: new Date(Date.now() - 60_000),
      },
    });
    const customized = await owner("/api/pet", json("PATCH", { ...appearance, theme: "ocean", name: "Maré" }));
    assert.equal(customized.status, 200);
    const customizedPet = (await customized.json()).pet;
    assert.ok(customizedPet.hunger > 55.9 && customizedPet.hunger <= 56,
      "customization persists accumulated decay rather than resetting the decay clock");
    assert.equal(customizedPet.name, "Maré");
    assert.equal(customizedPet.theme, "ocean");
    const fed = await owner("/api/pet", json("PATCH", { action: "feed" }));
    assert.equal(fed.status, 200, "customization does not spend the separate action cooldown");
    const fedPet = (await fed.json()).pet;
    assert.ok(fedPet.hunger > 80.9 && fedPet.hunger <= 81);
    assert.equal((await owner("/api/pet", json("PATCH", { action: "play" }))).status, 429);
    const recolored = await owner("/api/pet", json("PATCH", { ...appearance, petColor: "#123456" }));
    assert.equal(recolored.status, 200);
    assert.equal((await recolored.json()).pet.lastActionAt, fedPet.lastActionAt);
    assert.equal((await owner("/api/pet", json("PATCH", { action: "play" }))).status, 429,
      "customization must not bypass cooldown");
    assert.equal((await owner("/api/pet", json("PATCH", { ...appearance, petColor: "red; display:none" }))).status, 400);

    const before = await db.pet.update({
      where: { id: pet.id },
      data: { lastActionAt: null, hunger: 50, happiness: 50, energy: 50, cleanliness: 50 },
    });
    const competing = await Promise.all([
      owner("/api/pet", json("PATCH", { action: "feed" })),
      owner("/api/pet", json("PATCH", { action: "play" })),
    ]);
    assert.equal(competing.filter((response) => response.status === 200).length, 1);
    assert.ok(competing.some((response) => response.status === 409 || response.status === 429));
    assert.equal((await db.pet.findUniqueOrThrow({ where: { id: pet.id } })).version, before.version + 1);

    for (let attempt = 0; attempt < 32; attempt++) await other("/api/pet", json("PATCH", { action: "feed" }));
    const flagged = await db.user.findUniqueOrThrow({ where: { id: userIds[1] } });
    assert.equal(flagged.suspiciousScore, 30);
    assert.deepEqual(flagged.suspiciousReasons, ["Excessive pet activity"]);

    await db.user.update({ where: { id: userIds[0] }, data: { blocked: true } });
    assert.equal((await owner("/api/pet")).status, 401, "blocking revokes access for an existing JWT");
    await db.user.update({
      where: { id: userIds[0] }, data: { blocked: false, sessionVersion: { increment: 1 } },
    });
    assert.equal((await owner("/api/pet")).status, 401, "old JWT remains invalid after unblock or password reset");
    await login(owner, emails[0]);
    assert.equal((await owner("/api/pet")).status, 200);
    await db.user.delete({ where: { id: userIds[0] } });
    assert.equal((await owner("/api/pet")).status, 401, "deleted accounts cannot use existing sessions");
  } finally {
    server.kill("SIGTERM");
    if (server.exitCode === null) await Promise.race([
      once(server, "exit"),
      new Promise<void>((resolve) => setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 5_000).unref()),
    ]);
    await db.user.deleteMany({ where: { email: { in: emails } } });
    await db.rateLimit.deleteMany({ where: { key: { in: [
      ...userIds.map((id) => `pet:${id}`), ...emails.map((email) => `login:email:${hashToken(email)}`),
      `login:client:${clientHash}`,
    ] } } });
    await db.$disconnect();
  }
});
