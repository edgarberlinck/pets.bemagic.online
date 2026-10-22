import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { consumeRateLimit, enforceSameOrigin } from "@/lib/rate-limit";
import { isAllowedPushEndpoint, parsePushSubscription, readPushBody } from "@/lib/push";

export const runtime = "nodejs";
const reply = (message: string, status: number) =>
  Response.json({ message }, { status, headers: { "Cache-Control": "no-store" } });

function accountChanged(request: Request, userId: string) {
  const expected = request.headers.get("x-push-account");
  return !!expected && expected !== userId;
}

const changedAccount = () => Response.json({
  message: "A conta mudou. Tente novamente.", code: "account_changed",
}, { status: 409, headers: { "Cache-Control": "no-store" } });

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    if (!user) return reply("Entre na sua conta.", 401);
    if (user.blocked || !user.emailVerified) return reply("Conta indisponível.", 403);
    if (accountChanged(request, user.id)) return changedAccount();
    if (!await consumeRateLimit(`push-read:${user.id}`, 120, 60 * 60 * 1000))
      return reply("Tente novamente mais tarde.", 429);
    const subscriptions = await db.pushSubscription.findMany({
      where: { userId: user.id }, select: { endpoint: true },
      orderBy: { createdAt: "desc" }, take: 3,
    });
    return Response.json({ accountId: user.id, endpoints: subscriptions.map((item) => item.endpoint) }, {
      headers: { "Cache-Control": "private, no-store", Vary: "Cookie" },
    });
  } catch {
    return reply("Serviço indisponível. Tente novamente.", 503);
  }
}

async function mutate(request: Request, remove: boolean) {
  if (!enforceSameOrigin(request)) return reply("Origem inválida.", 403);
  try {
    const user = await requireUser();
    if (!user) return reply("Entre na sua conta.", 401);
    if (user.blocked || !user.emailVerified) return reply("Conta indisponível.", 403);
    if (accountChanged(request, user.id)) return changedAccount();
    if (!await consumeRateLimit(`push:${user.id}`, 20, 60 * 60 * 1000))
      return reply("Tente novamente mais tarde.", 429);
    let body: unknown;
    try { body = await readPushBody(request); }
    catch { return reply("Assinatura inválida.", 400); }
    if (remove) {
      const endpoint = body && typeof body === "object" && "endpoint" in body ? body.endpoint : null;
      if (!isAllowedPushEndpoint(endpoint)) return reply("Assinatura inválida.", 400);
      await db.pushSubscription.deleteMany({ where: { userId: user.id, endpoint } });
      return reply("Notificações desativadas.", 200);
    }
    const subscription = parsePushSubscription(body);
    if (!subscription) return reply("Assinatura inválida.", 400);
    const saved = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${user.id}))`;
      const existing = await tx.pushSubscription.findUnique({ where: { endpoint: subscription.endpoint } });
      if (existing && existing.userId !== user.id) return "endpoint_owned";
      if (existing) {
        await tx.pushSubscription.update({ where: { id: existing.id }, data: subscription });
      } else {
        if (await tx.pushSubscription.count({ where: { userId: user.id } }) >= 3) return "device_limit";
        // Preserve today's reservation even if the browser rotates its endpoint.
        const latest = await tx.pushSubscription.findFirst({
          where: { userId: user.id, lastNotifiedAt: { not: null } },
          orderBy: { lastNotifiedAt: "desc" },
        });
        await tx.pushSubscription.create({
          data: { ...subscription, userId: user.id, lastNotifiedAt: latest?.lastNotifiedAt },
        });
      }
      return "saved";
    });
    return saved === "saved" ? reply("Notificações ativadas.", 200) : Response.json({
      message: "Não foi possível salvar este dispositivo.", code: saved,
    }, { status: 409, headers: { "Cache-Control": "no-store" } });
  } catch {
    return reply("Serviço indisponível. Tente novamente.", 503);
  }
}

export async function POST(request: Request) { return mutate(request, false); }
export async function DELETE(request: Request) { return mutate(request, true); }
