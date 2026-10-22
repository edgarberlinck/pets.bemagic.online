import { db } from "@/lib/db";
import { hashToken } from "@/lib/account-security";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function GET(request: Request) {
  let valid = false;
  try {
    const token = new URL(request.url).searchParams.get("token");
    if (token && /^[a-f0-9]{64}$/.test(token) && await rateLimit(request, "verify", 60, 15 * 60_000)) {
      valid = await db.$transaction(async (tx) => {
        const record = await tx.verificationToken.findUnique({ where: { tokenHash: hashToken(token) } });
        if (!record || record.expiresAt <= new Date()) return false;
        const consumed = await tx.verificationToken.deleteMany({
          where: { id: record.id, expiresAt: { gt: new Date() } },
        });
        if (!consumed.count) return false;
        const updated = await tx.user.updateMany({
          where: { id: record.userId, blocked: false, emailVerified: null },
          data: { emailVerified: new Date() },
        });
        await tx.verificationToken.deleteMany({ where: { userId: record.userId } });
        return updated.count === 1;
      });
    }
  } catch { /* Invalid or unavailable verification never exposes account information. */ }
  const location = new URL("/", process.env.NEXTAUTH_URL ?? request.url);
  location.searchParams.set("verified", valid ? "1" : "invalid");
  return new Response(null, {
    status: 303,
    headers: { Location: location.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}
