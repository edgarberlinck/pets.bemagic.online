import { db } from "./db";
import { isSameOrigin, trustedClientKey } from "./account-security";

export const enforceSameOrigin = isSameOrigin;

export async function consumeRateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
  const rows = await db.$queryRaw<{ hits: number }[]>`
    INSERT INTO "RateLimit" ("key", "hits", "resetAt")
    VALUES (${key}, 1, NOW() + ${windowMs} * INTERVAL '1 millisecond')
    ON CONFLICT ("key") DO UPDATE SET
      "hits" = CASE WHEN "RateLimit"."resetAt" <= NOW() THEN 1 ELSE "RateLimit"."hits" + 1 END,
      "resetAt" = CASE WHEN "RateLimit"."resetAt" <= NOW()
        THEN NOW() + ${windowMs} * INTERVAL '1 millisecond' ELSE "RateLimit"."resetAt" END
    RETURNING "hits"
  `;
  return rows[0].hits <= limit;
}

export async function rateLimit(request: Request, scope: string, limit: number, windowMs: number): Promise<boolean> {
  return consumeRateLimit(`${scope}:${trustedClientKey(request.headers)}`, limit, windowMs);
}
