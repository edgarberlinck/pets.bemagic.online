import webPush from "web-push";
import { db } from "@/lib/db";
import { cronAuthorized, parsePushSubscription, petNeedsCare } from "@/lib/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  if (!cronAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET))
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject)
    return Response.json({ error: "Unavailable" }, { status: 503, headers });
  try {
    webPush.setVapidDetails(subject, publicKey, privateKey);
    const now = new Date();
    const day = new Date(now);
    day.setUTCHours(0, 0, 0, 0);
    const users = await db.user.findMany({
      where: {
        blocked: false, emailVerified: { not: null }, pet: { isNot: null },
        pushSubscriptions: {
          some: {}, none: { lastNotifiedAt: { gte: day } },
        },
      },
      select: { id: true, pet: true },
      orderBy: { pet: { updatedAt: "asc" } },
      take: 20,
    });
    let sent = 0;
    for (let offset = 0; offset < users.length; offset += 5) {
      await Promise.all(users.slice(offset, offset + 5).map(async (candidate) => {
        if (!candidate.pet || !petNeedsCare(candidate.pet, now)) return;
        const subscriptions = await db.$transaction(async (tx) => {
          // Lock per owner, not per subscription: concurrent cron runs reserve once.
          await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${candidate.id}))`;
          const user = await tx.user.findUnique({
            where: { id: candidate.id }, include: { pet: true },
          });
          if (!user || user.blocked || !user.emailVerified || !user.pet || !petNeedsCare(user.pet, now))
            return [];
          if (await tx.pushSubscription.count({
            where: { userId: user.id, lastNotifiedAt: { gte: day } },
          })) return [];
          const items = await tx.pushSubscription.findMany({
            where: { userId: user.id }, orderBy: { createdAt: "asc" }, take: 3,
          });
          if (!items.length) return [];
          // This durable owner reservation survives unsubscribing every device.
          const nextDay = new Date(day.getTime() + 86_400_000);
          const reserved = await tx.$queryRaw<{ hits: number }[]>`
            INSERT INTO "RateLimit" ("key", "hits", "resetAt")
            VALUES (${`push-notify:${user.id}`}, 1, ${nextDay})
            ON CONFLICT ("key") DO UPDATE SET "hits" = 1, "resetAt" = ${nextDay}
            WHERE "RateLimit"."resetAt" <= ${now}
            RETURNING "hits"
          `;
          if (!reserved.length) return [];
          await tx.pushSubscription.updateMany({
            where: { userId: user.id }, data: { lastNotifiedAt: now },
          });
          return items;
        });
        for (const item of subscriptions) {
          const validated = parsePushSubscription({
            endpoint: item.endpoint, keys: { p256dh: item.p256dh, auth: item.auth },
          });
          if (!validated) continue;
          try {
            await webPush.sendNotification({
              endpoint: validated.endpoint,
              keys: { p256dh: validated.p256dh, auth: validated.auth },
            }, JSON.stringify({
              title: "Seu pet está com saudade!",
              body: "Visite seu bichinho para cuidar dele.",
            }), { TTL: 3600, timeout: 4000, urgency: "normal" });
            sent++;
          } catch (error) {
            const status = (error as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410)
              await db.pushSubscription.deleteMany({ where: { id: item.id, endpoint: item.endpoint } });
          }
        }
      }));
    }
    return Response.json({ sent }, { headers });
  } catch {
    return Response.json({ error: "Unavailable" }, { status: 503, headers });
  }
}
