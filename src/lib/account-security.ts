import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import disposableDomains from "disposable-email-domains";

const disposable = new Set(disposableDomains);
const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(email))
    return null;
  const [local, domain] = email.split("@");
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..") ||
      domain.split(".").some((label) => label.length > 63 || label.startsWith("-") || label.endsWith("-") || !label))
    return null;
  return email;
}

export function isDisposableEmail(email: string): boolean {
  const labels = email.split("@")[1]?.toLowerCase().split(".") ?? [];
  return labels.some((_, index) => disposable.has(labels.slice(index).join(".")));
}

export function validatePassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 12 && value.length <= 128 &&
    Buffer.byteLength(value, "utf8") <= 512 && !/^\s+$/.test(value);
}

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (!validatePassword(password)) throw new Error("Password must be 12–128 characters.");
  const salt = randomBytes(16).toString("hex");
  return `scrypt-v1$${salt}$${(await derive(password, salt)).toString("hex")}`;
}

export async function verifyPassword(password: unknown, stored: string): Promise<boolean> {
  if (typeof password !== "string" || password.length > 128 || Buffer.byteLength(password) > 512)
    return false;
  const [version, salt, hex, extra] = stored.split("$");
  if (version !== "scrypt-v1" || !/^[a-f0-9]{32}$/.test(salt ?? "") ||
      !/^[a-f0-9]{128}$/.test(hex ?? "") || extra !== undefined) return false;
  return timingSafeEqual(await derive(password, salt), Buffer.from(hex, "hex"));
}

export function createVerificationToken() {
  const token = randomBytes(32).toString("hex");
  return { token, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 60 * 60 * 1000) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function accountRisk(email: string): { score: number; reasons: string[] } {
  const local = email.split("@")[0];
  const reasons: string[] = [];
  if (/\d{6,}/.test(local)) reasons.push("Long numeric sequence in email");
  if (local.length >= 40) reasons.push("Unusually long email name");
  return { score: reasons.length * 15, reasons };
}

export function trustedClientKey(headers: Headers): string {
  // Only Vercel's overwritten header is trusted; all other deployments share a bucket.
  const address = process.env.VERCEL === "1" ? headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() : null;
  return address ? hashToken(address).slice(0, 40) : "shared";
}

export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const configured = process.env.NEXTAUTH_URL;
  if (!origin || !configured) return false;
  try {
    return new URL(origin).origin === new URL(configured).origin &&
      request.headers.get("sec-fetch-site") !== "cross-site";
  } catch {
    return false;
  }
}

export async function sendVerificationEmail(user: { id: string; email: string }): Promise<void> {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM || !process.env.NEXTAUTH_URL)
    throw new Error("Email service not configured");
  const { db } = await import("./db");
  const { token, tokenHash, expiresAt } = createVerificationToken();
  const record = await db.verificationToken.create({ data: { userId: user.id, tokenHash, expiresAt } });
  const url = new URL("/api/auth/verify", process.env.NEXTAUTH_URL);
  url.searchParams.set("token", token);
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: ["Bearer", process.env.RESEND_API_KEY].join(" "),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM,
        to: [user.email],
        subject: "Verify your BeMagic Pets email",
        text: `Welcome! Verify your email within one hour:\n\n${url.toString()}\n\nIf you didn't create this account, ignore this email.`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Email delivery unavailable");
  } catch {
    // A failed delivery must not invalidate links from earlier successful deliveries.
    await db.verificationToken.deleteMany({ where: { id: record.id } });
    throw new Error("Email delivery unavailable");
  }
}
