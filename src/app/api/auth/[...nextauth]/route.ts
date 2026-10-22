import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";
import { enforceSameOrigin } from "@/lib/rate-limit";

export const runtime = "nodejs";
const handler = NextAuth(authOptions);
export { handler as GET };

export async function POST(request: Request, context: { params: Promise<{ nextauth: string[] }> }) {
  if (!enforceSameOrigin(request)) return Response.json({ error: "Invalid origin." }, { status: 403 });
  return handler(request, context);
}
