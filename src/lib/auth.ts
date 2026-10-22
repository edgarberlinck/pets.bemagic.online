import { getServerSession, type NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import type { User } from "@prisma/client";
import { db } from "./db";
import { hashToken, normalizeEmail, trustedClientKey, verifyPassword } from "./account-security";
import { consumeRateLimit } from "./rate-limit";

const dummyHash = `scrypt-v1$${"0".repeat(32)}$${"0".repeat(128)}`;

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  session: { strategy: "jwt", maxAge: 24 * 60 * 60 },
  pages: { signIn: "/" },
  providers: [
    CredentialsProvider({
      name: "Email and password",
      credentials: { email: { type: "email" }, password: { type: "password" } },
      async authorize(credentials, request) {
        const email = normalizeEmail(credentials?.email);
        if (!email || typeof credentials?.password !== "string") return null;
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers ?? {})) {
          if (typeof value === "string") headers.set(key, value);
        }
        if (!await consumeRateLimit(`login:client:${trustedClientKey(headers)}`, 30, 15 * 60_000) ||
            !await consumeRateLimit(`login:email:${hashToken(email)}`, 10, 15 * 60_000)) return null;
        const user = await db.user.findUnique({ where: { email } });
        const matches = await verifyPassword(credentials.password, user?.passwordHash ?? dummyHash);
        if (user && !matches) {
          const failed = await db.user.update({
            where: { id: user.id },
            data: { failedLoginCount: { increment: 1 }, lastFailedLoginAt: new Date() },
          });
          if (failed.failedLoginCount >= 5) {
            await db.user.updateMany({
              where: { id: user.id, NOT: { suspiciousReasons: { has: "Repeated failed logins" } } },
              data: {
                suspiciousScore: { increment: 50 },
                suspiciousReasons: { push: "Repeated failed logins" },
                reviewedAt: null,
              },
            });
          }
        }
        if (!user || !matches || user.blocked || !user.emailVerified) return null;
        await db.user.update({ where: { id: user.id }, data: { failedLoginCount: 0 } });
        return { id: user.id, email: user.email, sessionVersion: user.sessionVersion };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.sessionVersion = user.sessionVersion;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.id) {
        session.user.id = token.id;
        session.user.sessionVersion = token.sessionVersion ?? -1;
      }
      return session;
    },
  },
};

/** Every protected request must call this; JWT claims alone do not authorize access. */
export async function requireUser(): Promise<User | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return null;
  const user = await db.user.findUnique({ where: { id: session.user.id } });
  return user && !user.blocked && user.emailVerified &&
    user.sessionVersion === session.user.sessionVersion ? user : null;
}
