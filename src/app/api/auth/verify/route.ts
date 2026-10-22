import { db } from "@/lib/db";
import { AccountBodyError, hashPassword, hashToken, readAccountBody, validatePassword } from "@/lib/account-security";
import { enforceSameOrigin, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token");
  const location = new URL("/", process.env.NEXTAUTH_URL ?? request.url);
  if (token && /^[a-f0-9]{64}$/.test(token)) location.searchParams.set("verification", token);
  else location.searchParams.set("verified", "invalid");
  return new Response(null, {
    status: 303,
    headers: { Location: location.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

export async function POST(request: Request) {
  if (!enforceSameOrigin(request)) return Response.json({ error: "Origem inválida." }, { status: 403 });
  const invalid = () => Response.json({ error: "Não foi possível confirmar a conta. Solicite um novo link e tente novamente." }, {
    status: 400, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
  try {
    if (!await rateLimit(request, "verify-activate", 15, 15 * 60_000))
      return Response.json({ error: "Tente novamente mais tarde." }, { status: 429 });
    const body = await readAccountBody(request);
    if (typeof body.token !== "string" || !/^[a-f0-9]{64}$/.test(body.token) || !validatePassword(body.password))
      return invalid();
    const tokenHash = hashToken(body.token);
    // The email holder must choose the final password; a preregistrant's password is never activated.
    const passwordHash = await hashPassword(body.password);
    const valid = await db.$transaction(async (tx) => {
      const record = await tx.verificationToken.findUnique({
        where: { tokenHash },
        include: { user: { select: { blocked: true, emailVerified: true } } },
      });
      if (!record || record.expiresAt <= new Date() || record.user.blocked || record.user.emailVerified) return false;
      const consumed = await tx.verificationToken.deleteMany({
        where: { id: record.id, expiresAt: { gt: new Date() } },
      });
      if (!consumed.count) return false;
      const updated = await tx.user.updateMany({
        where: { id: record.userId, blocked: false, emailVerified: null },
        data: { passwordHash, emailVerified: new Date(), sessionVersion: { increment: 1 } },
      });
      await tx.verificationToken.deleteMany({ where: { userId: record.userId } });
      return updated.count === 1;
    });
    if (!valid) return invalid();
    return Response.json({ message: "E-mail confirmado e senha definida. Agora você pode entrar!" }, {
      headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  } catch (error) {
    if (error instanceof AccountBodyError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "Serviço temporariamente indisponível." }, { status: 503 });
  }
}
