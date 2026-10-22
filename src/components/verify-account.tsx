"use client";

import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function VerifyAccount({ token }: { token: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function verify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("newPassword") ?? "");
    if (!password.trim()) {
      setMessage("Escolha uma senha que não seja composta apenas por espaços.");
      return;
    }
    if (password !== form.get("confirmPassword")) {
      setMessage("As senhas precisam ser iguais.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (response.ok) {
        window.location.replace("/?verified=1#conta");
        return;
      }
      setMessage("Não foi possível confirmar. O link pode ter expirado. Solicite outra confirmação na seção de conta.");
    } catch {
      setMessage("Sem conexão. Reconecte e tente novamente.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="verification-panel" aria-labelledby="verification-title">
      <div>
        <span className="eyebrow"><ShieldCheck size={16} /> CONFIRME SEU CANTINHO</span>
        <h2 id="verification-title">Este email é seu. A senha também.</h2>
        <p>Para ativar sua conta com segurança, escolha a senha definitiva aqui. Ela substitui qualquer senha informada antes da confirmação.</p>
      </div>
      <form onSubmit={verify} className="account-form">
        <label htmlFor="newPassword">Sua senha definitiva</label>
        <Input id="newPassword" name="newPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required placeholder="No mínimo 12 caracteres" />
        <label htmlFor="confirmPassword">Confirme a senha</label>
        <Input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={128} required />
        <Button className="w-full mt-5" disabled={busy}>{busy ? "Confirmando…" : "Confirmar email e definir senha"}</Button>
        <p className="form-message" role="status">{message}</p>
      </form>
    </section>
  );
}
