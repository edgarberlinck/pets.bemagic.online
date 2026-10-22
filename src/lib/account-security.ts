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

export class AccountBodyError extends Error {
  constructor(public readonly status: 400 | 413, message: string) {
    super(message);
    this.name = "AccountBodyError";
  }
}

/** Reads a JSON object with a 4096-byte streaming limit; throws AccountBodyError (400/413). */
export async function readAccountBody(request: Request): Promise<Record<string, unknown>> {
  const maximum = 4096;
  const length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > maximum)
    throw new AccountBodyError(413, "Os dados enviados são muito grandes.");
  if (!request.body) throw new AccountBodyError(400, "Dados inválidos.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new AccountBodyError(413, "Os dados enviados são muito grandes.");
      }
      chunks.push(value);
    }
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new AccountBodyError(400, "Envie um objeto JSON válido.");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AccountBodyError) throw error;
    throw new AccountBodyError(400, "Dados inválidos.");
  } finally {
    reader.releaseLock();
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
        subject: "Confirme seu e-mail no BeMagic Pets",
        text: `Boas-vindas ao BeMagic Pets! Acesse o link em até uma hora para confirmar seu e-mail e definir sua senha:\n\n${url.toString()}\n\nSomente a senha definida nessa confirmação poderá acessar sua conta. Se você não criou esta conta, ignore esta mensagem.`,
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
