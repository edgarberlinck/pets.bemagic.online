import { db } from "@/lib/db";
import { AccountBodyError, hashToken, normalizeEmail, readAccountBody, sendVerificationEmail } from "@/lib/account-security";
import { consumeRateLimit, enforceSameOrigin, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!enforceSameOrigin(request)) return Response.json({ error: "Origem inválida." }, { status: 403 });
  try {
    if (!await rateLimit(request, "resend", 15, 60 * 60_000))
      return Response.json({ error: "Tente novamente mais tarde." }, { status: 429 });
    const body = await readAccountBody(request);
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
    return Response.json({ message: "Se este endereço puder receber a confirmação, um e-mail chegará em breve." }, { status: 202 });
  } catch (error) {
    if (error instanceof AccountBodyError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "Serviço temporariamente indisponível." }, { status: 503 });
  }
}
