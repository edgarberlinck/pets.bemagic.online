import { ECDH, createHash, timingSafeEqual } from "node:crypto";
import { evolvePet } from "./game";

const ENDPOINT_PATHS: Record<string, RegExp> = {
  "fcm.googleapis.com": /^\/fcm\/send\/[A-Za-z0-9_:-]{16,2048}$/,
  "updates.push.services.mozilla.com": /^\/wpush\/v[12]\/[A-Za-z0-9_-]{16,2048}={0,2}$/,
  "web.push.apple.com": /^\/Q[A-Za-z0-9_-]{16,2048}$/,
};

export function isAllowedPushEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2300) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      !url.search && !url.hash && value === `https://${url.hostname}${url.pathname}` &&
      !!ENDPOINT_PATHS[url.hostname]?.test(url.pathname);
  } catch {
    return false;
  }
}

function decodeKey(value: unknown, length: number): Buffer | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === length && bytes.toString("base64url") === value.replace(/=+$/, "") ? bytes : null;
}

export function parsePushSubscription(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const { endpoint, keys } = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (!isAllowedPushEndpoint(endpoint) || !keys || typeof keys !== "object") return null;
  const p256dh = decodeKey(keys.p256dh, 65);
  const auth = decodeKey(keys.auth, 16);
  if (!p256dh || p256dh[0] !== 4 || !auth) return null;
  try {
    ECDH.convertKey(p256dh, "prime256v1");
  } catch {
    return null;
  }
  return { endpoint, p256dh: p256dh.toString("base64url"), auth: auth.toString("base64url") };
}

export async function readPushBody(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    throw new Error("Invalid body");
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 4096)) throw new Error("Invalid body");
  if (!request.body) throw new Error("Invalid body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        throw new Error("Invalid body");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function cronAuthorized(authorization: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 32 || !authorization) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(authorization), digest(["Bearer", secret].join(" ")));
}

export function petNeedsCare(pet: {
  hunger: number; happiness: number; energy: number; cleanliness: number; updatedAt: Date;
}, now = new Date()): boolean {
  const current = evolvePet(pet, pet.updatedAt, now);
  return current.hunger <= 30 || current.happiness <= 30 ||
    current.energy <= 30 || current.cleanliness <= 30;
}
