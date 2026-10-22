import { db } from "@/lib/db";
import { hashToken, normalizeEmail, sendVerificationEmail } from "@/lib/account-security";
import { consumeRateLimit, enforceSameOrigin, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!enforceSameOrigin(request)) return Response.json({ error: "Invalid origin." }, { status: 403 });
  try {
    if (!await rateLimit(request, "resend", 15, 60 * 60_000))
      return Response.json({ error: "Please try again later." }, { status: 429 });
    const body = await request.json();
    const email = normalizeEmail(body?.email);
    if (email && await consumeRateLimit(`resend:email:${hashToken(email)}`, 5, 15 * 60_000)) {
      const user = await db.user.findUnique({ where: { email } });
      if (user && !user.emailVerified && !user.blocked) {
        try { await sendVerificationEmail(user); } catch {
          // Delivery failures should not spend the account's resend allowance.
          await db.rateLimit.updateMany({
            where: { key: `resend:email:${hashToken(email)}`, hits: { gt: 0 } },
            data: { hits: { decrement: 1 } },
          });
        }
      }
    }
    return Response.json({ message: "If this address is eligible, a verification email will arrive shortly." }, { status: 202 });
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: "Invalid request." }, { status: 400 });
    return Response.json({ error: "Service temporarily unavailable." }, { status: 503 });
  }
}
