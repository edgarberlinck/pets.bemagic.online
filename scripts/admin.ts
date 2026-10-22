import { createInterface, emitKeypressEvents } from "node:readline";
import { db } from "../src/lib/db";
import { hashPassword, isDisposableEmail, normalizeEmail, verifyPassword } from "../src/lib/account-security";

class AdminError extends Error {}

const help = `
BeMagic Pets administration

Usage: npx tsx --env-file=.env scripts/admin.ts <command> [email]

  admin EMAIL          Create or update a verified, active administrator
  list                 List accounts (never password hashes or tokens)
  block EMAIL          Block access and revoke existing sessions
  unblock EMAIL        Restore access
  delete EMAIL         Permanently delete account and pet; confirmation required
  suspicious           List accounts with security flags
  review EMAIL         Mark security flags reviewed and reset failed-login counter
  reset-password EMAIL Set a new password and revoke existing sessions
  --help               Show this help

All credentials are prompted securely on a terminal, never accepted as arguments.
Authenticate with a verified, active admin. Only "admin" can bootstrap when no
admins exist. Bootstrap is for trusted database operators; protect DATABASE_URL.
Last active administrator cannot be blocked or deleted. Every operation is audited.
Required environment: DATABASE_URL. Use --env-file only if that file exists.
`;

function prompt(label: string, secret = false): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new AdminError("An interactive terminal is required for secure credential prompts.");
  if (!secret) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(label, (answer) => { rl.close(); resolve(answer.trim()); }));
  }
  process.stdout.write(label);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      process.stdin.off("keypress", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onKey = (text: string | undefined, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") { finish(); reject(new AdminError("Cancelled.")); }
      else if (key.name === "return" || key.name === "enter") { finish(); resolve(value); }
      else if (key.name === "backspace") value = [...value].slice(0, -1).join("");
      else if (text && !key.ctrl && !text.includes("\u001b") && value.length < 129) value += text;
    };
    process.stdin.on("keypress", onKey);
  });
}

async function main() {
  const [command, targetInput, ...extra] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") { console.log(help); return; }
  const commands = ["admin", "list", "block", "unblock", "delete", "suspicious", "review", "reset-password"];
  if (!commands.includes(command) || extra.length ||
      (["list", "suspicious"].includes(command) ? !!targetInput : !targetInput))
    throw new AdminError("Invalid arguments. Run with --help. Never pass passwords as arguments.");
  const email = targetInput ? normalizeEmail(targetInput) : null;
  if (targetInput && !email) throw new AdminError("Invalid email address.");

  const adminCount = await db.user.count({ where: { role: "ADMIN" } });
  let actor: { id: string; passwordHash: string } | null = null;
  if (!adminCount && command !== "admin") throw new AdminError("Bootstrap an administrator first with: admin EMAIL");
  if (adminCount) {
    const actorEmail = normalizeEmail(await prompt("Admin email: "));
    const password = await prompt("Admin password: ", true);
    const found = actorEmail ? await db.user.findUnique({ where: { email: actorEmail } }) : null;
    if (!found || !await verifyPassword(password, found.passwordHash) ||
        found.role !== "ADMIN" || found.blocked || !found.emailVerified)
      throw new AdminError("Administrator authentication failed.");
    actor = { id: found.id, passwordHash: found.passwordHash };
  } else {
    console.log("No administrators exist. Bootstrapping a trusted database operator.");
  }

  let passwordHash: string | undefined;
  if (command === "admin" || command === "reset-password") {
    const password = await prompt("New password (12–128 characters): ", true);
    const confirmation = await prompt("Confirm new password: ", true);
    if (password !== confirmation) throw new AdminError("Passwords do not match.");
    if (password.length < 12 || password.length > 128 || /^\s+$/.test(password))
      throw new AdminError("Password must be 12–128 non-blank characters.");
    passwordHash = await hashPassword(password);
  }
  if (command === "delete" && await prompt(`Type DELETE ${email} to permanently delete this account: `) !== `DELETE ${email}`)
    throw new AdminError("Deletion cancelled.");

  await db.$transaction(async (tx) => {
    // Serialize all admin mutations, including concurrent bootstrap and last-admin checks.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(724683190)`;
    if (actor) {
      const current = await tx.user.findUnique({ where: { id: actor.id } });
      if (!current || current.role !== "ADMIN" || current.blocked || !current.emailVerified ||
          current.passwordHash !== actor.passwordHash)
        throw new AdminError("Administrator authorization changed. Authenticate again.");
    } else if (await tx.user.count({ where: { role: "ADMIN" } })) {
      throw new AdminError("An administrator now exists. Authenticate and retry.");
    }
    const target = email ? await tx.user.findUnique({ where: { email } }) : null;
    if (email && !target && command !== "admin") throw new AdminError("Account not found.");
    if (target?.role === "ADMIN" && !target.blocked && target.emailVerified &&
        (command === "delete" || command === "block") &&
        await tx.user.count({ where: { role: "ADMIN", blocked: false, emailVerified: { not: null } } }) <= 1)
      throw new AdminError("Cannot remove the last active administrator.");

    let targetId = target?.id;
    if (command === "list" || command === "suspicious") {
      const users = await tx.user.findMany({
        where: command === "suspicious" ? { suspiciousScore: { gt: 0 } } : {},
        select: {
          id: true, email: true, role: true, blocked: true, emailVerified: true,
          suspiciousScore: true, suspiciousReasons: true, reviewedAt: true,
          failedLoginCount: true, lastFailedLoginAt: true, createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 500,
      });
      console.log(JSON.stringify(users, null, 2));
      if (users.length === 500) console.log("Showing the newest 500 accounts.");
    } else if (command === "admin" && email) {
      if (isDisposableEmail(email)) throw new AdminError("Use a permanent administrator email.");
      const user = await tx.user.upsert({
        where: { email },
        create: { email, passwordHash: passwordHash!, role: "ADMIN", emailVerified: new Date() },
        update: {
          passwordHash, role: "ADMIN", emailVerified: new Date(), blocked: false,
          sessionVersion: { increment: 1 },
        },
      });
      targetId = user.id;
      await tx.verificationToken.deleteMany({ where: { userId: user.id } });
    } else if (target) {
      if (command === "delete") await tx.user.delete({ where: { id: target.id } });
      else if (command === "review") await tx.user.update({
        where: { id: target.id },
        data: { reviewedAt: new Date(), failedLoginCount: 0, suspiciousScore: 0, suspiciousReasons: [] },
      });
      else if (command === "reset-password") {
        await tx.user.update({
          where: { id: target.id },
          data: { passwordHash, sessionVersion: { increment: 1 }, failedLoginCount: 0 },
        });
        await tx.verificationToken.deleteMany({ where: { userId: target.id } });
      } else await tx.user.update({
        where: { id: target.id },
        data: { blocked: command === "block", sessionVersion: { increment: 1 } },
      });
    }
    await tx.auditLog.create({ data: { actorId: actor?.id ?? targetId, action: `admin:${actor ? command : "bootstrap"}`, targetId } });
  }, { timeout: 15_000 });
  console.log("Operation completed and audited.");
}

main().catch((error: unknown) => {
  // Only display our own errors; database errors may contain connection secrets.
  console.error(error instanceof AdminError ? error.message : "Administration failed. Check database availability. Use --help.");
  process.exitCode = 1;
}).finally(async () => { await db.$disconnect(); });
