import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { accountRisk, hashPassword, isDisposableEmail, normalizeEmail, sendVerificationEmail, validatePassword } from "@/lib/account-security";
import { enforceSameOrigin, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
const message = "If this address is eligible, a verification email will arrive shortly. You can request another email if needed.";

export async function POST(request: Request) {
  if (!enforceSameOrigin(request)) return Response.json({ error: "Invalid origin." }, { status: 403 });
  try {
    if (!await rateLimit(request, "register", 10, 60 * 60_000))
      return Response.json({ error: "Please try again later." }, { status: 429 });
    const body = await request.json();
    const email = normalizeEmail(body?.email);
    if (!email || isDisposableEmail(email) || !validatePassword(body?.password))
      return Response.json({ error: "Use a permanent email address and a password of 12–128 characters." }, { status: 400 });
    const passwordHash = await hashPassword(body.password);
    const risk = accountRisk(email);
    try {
      const user = await db.user.create({
        data: { email, passwordHash, suspiciousScore: risk.score, suspiciousReasons: risk.reasons },
      });
      try { await sendVerificationEmail(user); } catch { /* Resend remains available after delivery failures. */ }
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
    }
    return Response.json({ message }, { status: 202 });
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: "Invalid request." }, { status: 400 });
    return Response.json({ error: "Service temporarily unavailable." }, { status: 503 });
  }
}
