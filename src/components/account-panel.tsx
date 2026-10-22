"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { ArrowRight, Mail, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function AccountPanel() {
  const [mode, setMode] = useState<"login" | "register" | "resend">("register");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");
    try {
      if (mode === "login") {
        const result = await signIn("credentials", { email, password, redirect: false });
        if (result?.error) setMessage("Não foi possível entrar. Confira seus dados, confirme seu email ou tente mais tarde.");
        else if (!result?.ok) setMessage("Não foi possível conectar. Tente novamente.");
      } else {
        const response = await fetch(`/api/auth/${mode === "register" ? "register" : "resend"}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, ...(mode === "register" ? { password } : {}) }),
        });
        const body = await response.json();
        setMessage(response.ok ? "Se o endereço estiver apto, você receberá um email. Confira também a pasta de spam." : body.error || "Não foi possível enviar. Tente novamente mais tarde.");
      }
    } catch {
      setMessage("Sem conexão. Confira sua internet e tente novamente.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="conta" className="account-section">
      <div>
        <span className="eyebrow"><ShieldCheck size={15} /> SEU AMIGO, SEMPRE COM VOCÊ</span>
        <h2>Pequenos cuidados.<br />Uma amizade de verdade.</h2>
        <p>Crie sua conta para adotar um pet, salvar seu progresso e levar seu pequeno mundo no bolso.</p>
        <p className="fine-print"><Mail size={15} /> Confirme seu email antes de começar. Não aceitamos emails temporários.</p>
      </div>
      <form className="account-form" onSubmit={submit}>
        <div className="flex gap-2 mb-5">
          <Button type="button" variant={mode === "register" ? "default" : "ghost"} size="sm" onClick={() => { setMode("register"); setMessage(""); }}>Criar conta</Button>
          <Button type="button" variant={mode === "login" ? "default" : "ghost"} size="sm" onClick={() => { setMode("login"); setMessage(""); }}>Já tenho conta</Button>
        </div>
        <label htmlFor="email">Seu email</label>
        <Input id="email" name="email" type="email" autoComplete="email" placeholder="voce@exemplo.com" maxLength={254} required />
        {mode !== "resend" && <>
          <label htmlFor="password">Sua senha</label>
          <Input id="password" name="password" type="password" autoComplete={mode === "register" ? "new-password" : "current-password"} placeholder={mode === "register" ? "No mínimo 12 caracteres" : "Sua senha"} minLength={mode === "register" ? 12 : 1} maxLength={128} required />
        </>}
        <Button className="w-full mt-5" disabled={busy}>{busy ? "Só um instante…" : mode === "login" ? "Entrar no meu mundo" : mode === "resend" ? "Reenviar confirmação" : "Começar minha aventura"}<ArrowRight /></Button>
        <button type="button" className="text-link mt-4" onClick={() => { setMode("resend"); setMessage(""); }}>Não recebeu a confirmação?</button>
        <p aria-live="polite" className="form-message">{message}</p>
      </form>
    </section>
  );
}
