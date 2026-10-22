import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { AccountBodyError, accountRisk, hashPassword, isDisposableEmail, normalizeEmail, readAccountBody, sendVerificationEmail, validatePassword } from "@/lib/account-security";
import { enforceSameOrigin, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
const message = "Se este endereço puder receber a confirmação, um e-mail chegará em breve. Você pode solicitar outro envio se precisar.";

export async function POST(request: Request) {
  if (!enforceSameOrigin(request)) return Response.json({ error: "Origem inválida." }, { status: 403 });
  try {
    if (!await rateLimit(request, "register", 10, 60 * 60_000))
      return Response.json({ error: "Tente novamente mais tarde." }, { status: 429 });
    const body = await readAccountBody(request);
    const email = normalizeEmail(body?.email);
    if (!email || isDisposableEmail(email) || !validatePassword(body?.password))
      return Response.json({ error: "Use um e-mail permanente e uma senha de 12 a 128 caracteres." }, { status: 400 });
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
    if (error instanceof AccountBodyError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "Serviço temporariamente indisponível." }, { status: 503 });
  }
}
