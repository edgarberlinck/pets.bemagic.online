import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { AccountBodyError, readAccountBody } from "@/lib/account-security";
import { ACTIONS, ACTION_COOLDOWN_MS, actionBlocked, applyAction, evolvePet, validTz, isColor, isTheme, type PetAction } from "@/lib/game";
import { consumeRateLimit, enforceSameOrigin } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function GET(request: Request) {
  const tz = validTz(new URL(request.url).searchParams.get("tz"));
  const user = await requireUser();
  if (!user) return json({ error: "Entre em uma conta confirmada e ativa." }, 401);
  const pet = await db.pet.findUnique({ where: { userId: user.id } });
  const now = new Date();
  return json({ pet: pet ? { ...evolvePet(pet, pet.updatedAt, now, pet.id, tz), updatedAt: now.toISOString() } : null });
}

async function mutationContext(request: Request) {
  if (!enforceSameOrigin(request)) return json({ error: "Origem inválida." }, 403);
  const user = await requireUser();
  if (!user) return json({ error: "Entre em uma conta confirmada e ativa." }, 401);
  if (!await consumeRateLimit(`pet:${user.id}`, 30, 60_000)) {
    await db.user.updateMany({
      where: { id: user.id, NOT: { suspiciousReasons: { has: "Excessive pet activity" } } },
      data: { suspiciousScore: { increment: 30 }, suspiciousReasons: { push: "Excessive pet activity" }, reviewedAt: null },
    });
    return json({ error: "Muitos cuidados de uma vez. Espere um minutinho." }, 429);
  }
  let body: Record<string, unknown>;
  try {
    body = await readAccountBody(request);
  } catch (error) {
    return json({ error: error instanceof AccountBodyError ? error.message : "Dados inválidos." }, error instanceof AccountBodyError ? error.status : 400);
  }
  return { user, body };
}

function validName(name: unknown): name is string {
  return typeof name === "string" && name.trim().length >= 1 && name.trim().length <= 24 && !/[\u0000-\u001f\u007f]/.test(name);
}

function appearance(body: Record<string, unknown>) {
  if (!isTheme(body.theme) || !isColor(body.petColor) || !isColor(body.backgroundColor)) return null;
  return { theme: body.theme, petColor: body.petColor, backgroundColor: body.backgroundColor };
}

export async function POST(request: Request) {
  const context = await mutationContext(request);
  if (context instanceof NextResponse) return context;
  const { user, body } = context;
  const colors = appearance(body);
  if (!validName(body.name) || !colors) return json({ error: "Escolha um nome de até 24 caracteres, um tema e cores válidas." }, 400);
  const existing = await db.pet.findUnique({ where: { userId: user.id } });
  if (existing) return json({ error: "Você já tem um companheiro. Cuide dele com carinho." }, 409);
  try {
    const pet = await db.pet.create({ data: { userId: user.id, name: body.name.trim(), ...colors } });
    return json({ pet }, 201);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") return json({ error: "Você já tem um pet. Atualize a página." }, 409);
    throw error;
  }
}

export async function PATCH(request: Request) {
  const context = await mutationContext(request);
  if (context instanceof NextResponse) return context;
  const { user, body } = context;
  const pet = await db.pet.findUnique({ where: { userId: user.id } });
  if (!pet) return json({ error: "Adote seu companheiro primeiro." }, 404);
  const now = new Date();
  const tz = validTz(body.tz);
  const current = evolvePet(pet, pet.updatedAt, now, pet.id, tz);
  let data;
  if (typeof body.action === "string" && ACTIONS.includes(body.action as PetAction)) {
    if (pet.lastActionAt && now.getTime() - pet.lastActionAt.getTime() < ACTION_COOLDOWN_MS) {
      return json({ error: "Um carinho por vez! Espere 10 segundos entre os cuidados." }, 429);
    }
    const blocked = actionBlocked(current, pet.id, body.action as PetAction, now, tz);
    if (blocked) return json({ error: blocked }, 409);
    const next = applyAction(current, body.action as PetAction);
    data = { hunger: next.hunger, happiness: next.happiness, energy: next.energy, cleanliness: next.cleanliness, lastActionAt: now };
  } else {
    const colors = appearance(body);
    if (!colors || "action" in body || ("name" in body && !validName(body.name))) return json({ error: "Personalização inválida." }, 400);
    data = { ...colors, ...(typeof body.name === "string" ? { name: body.name.trim() } : {}), hunger: current.hunger, happiness: current.happiness, energy: current.energy, cleanliness: current.cleanliness };
  }
  const result = await db.pet.updateMany({
    where: { id: pet.id, userId: user.id, version: pet.version },
    data: { ...data, updatedAt: now, version: { increment: 1 } },
  });
  if (!result.count) return json({ error: "Seu pet recebeu outro cuidado. Atualize a página antes de tentar novamente." }, 409);
  return json({ pet: await db.pet.findUnique({ where: { id: pet.id } }) });
}
