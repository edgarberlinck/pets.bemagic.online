import { PetsApp } from "@/components/pets-app";

export default async function Home({ searchParams }: PageProps<"/">) {
  const { verified, verification } = await searchParams;
  const verificationToken = typeof verification === "string" && /^[a-f0-9]{64}$/.test(verification) ? verification : undefined;
  return <PetsApp verificationToken={verificationToken} verification={verified ? verified === "1" ? "Email confirmado! Entre na sua conta para adotar seu pet." : "Link inválido ou expirado. Solicite outra confirmação abaixo." : ""} />;
}
