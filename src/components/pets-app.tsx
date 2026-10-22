"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { signOut, useSession } from "next-auth/react";
import Link from "next/link";
import { Apple, ArrowDown, ArrowRight, Check, Droplets, Heart, Leaf, LogOut, Moon, Palette, PawPrint, RotateCcw, Sparkles, Star, Sun, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AccountPanel } from "@/components/account-panel";
import { VerifyAccount } from "@/components/verify-account";
import { PixelPet } from "@/components/pixel-pet";
import { PwaControls } from "@/components/pwa-controls";
import { ACTIONS, PERSONALITIES, actionBlocked, applyAction, evolvePet, personalityOf, petWant, skyDim, sleepsUntil, growthScale, isTheme, THEMES, type GamePet, type PetAction, type ThemeName } from "@/lib/game";

const demo: GamePet = {
  id: "preview", name: "Pipoca", hunger: 78, happiness: 92, energy: 65, cleanliness: 84,
  theme: "meadow", petColor: "#a78bfa", backgroundColor: "#ecfdf5",
  version: 0, updatedAt: "2026-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z",
};
const care = [
  { action: "feed", label: "Alimentar", hint: "Uma delícia de cuidado", icon: Apple, color: "peach" },
  { action: "play", label: "Brincar", hint: "Hora de se divertir", icon: Heart, color: "pink" },
  { action: "sleep", label: "Descansar", hint: "Recarregar a energia", icon: Moon, color: "purple" },
  { action: "clean", label: "Dar banho", hint: "Limpinho e feliz", icon: Droplets, color: "blue" },
] as const;

export function PetsApp({ verification = "", verificationToken }: { verification?: string; verificationToken?: string }) {
  const { data: session, status } = useSession();
  const authenticated = status === "authenticated";
  const [pet, setPet] = useState<GamePet>(demo);
  const [hasPet, setHasPet] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [effect, setEffect] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [clock, setClock] = useState(0);
  const [theme, setTheme] = useState<ThemeName>("meadow");
  const [petColor, setPetColor] = useState(demo.petColor);
  const [backgroundColor, setBackgroundColor] = useState(demo.backgroundColor);
  const [petName, setPetName] = useState("");
  const themeConfig = THEMES[theme];
  const dim = clock ? skyDim(clock) : 0;
  const isNight = themeConfig.night || dim >= 0.3;
  const tz = -new Date().getTimezoneOffset();
  const stats = authenticated && hasPet && clock ? evolvePet(pet, pet.updatedAt, new Date(clock), pet.id, tz) : pet;
  const nowMs = clock || Date.parse(pet.updatedAt);
  const want = clock ? petWant(stats, pet.id, nowMs, tz) : "play";
  const asleep = want === "sleep";
  const personality = PERSONALITIES[personalityOf(pet.id)];
  const wakeTime = asleep ? new Date(sleepsUntil(pet.id, nowMs, tz)).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "";
  const blockedFor = (action: PetAction) => !clock ? null : actionBlocked(stats, pet.id, action, nowMs, tz);
  const statusText = { sleep: "💤 Dormindo", feed: "Com fome", play: "Quer brincar", quiet: "Quietinho", clean: "Precisa de banho" }[want];
  const wantText = { sleep: "Zzz… dormindo", feed: "Quero comer! ♡", play: "Vamos brincar? ✦", quiet: "Quero ficar quietinho… ✧", clean: "Preciso de um banho! ✨" }[want];

  const growth = authenticated && hasPet ? growthScale(pet.createdAt, clock || Date.parse(pet.updatedAt)) : 1;

  const clockOn = clock > 0;
  useEffect(() => {
    if (!clockOn || asleep) return;
    const start = setTimeout(() => setSpeaking(true), 0);
    const stop = setTimeout(() => setSpeaking(false), 7000);
    return () => { clearTimeout(start); clearTimeout(stop); setSpeaking(false); };
  }, [want, asleep, clockOn]);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    const first = setTimeout(() => setClock(Date.now()), 0);
    return () => { clearInterval(timer); clearTimeout(first); };
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const response = await fetch(`/api/pet?tz=${tz}`, { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Não foi possível carregar seu pet.");
        if (!cancelled && data.pet) {
          setPet(data.pet); setHasPet(true); setClock(Date.parse(data.pet.updatedAt));
          setTheme(isTheme(data.pet.theme) ? data.pet.theme : "meadow");
          setPetColor(data.pet.petColor); setBackgroundColor(data.pet.backgroundColor);
          setPetName(data.pet.name);
        }
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "Não foi possível conectar.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [authenticated, tz]);

  async function mutate(body: object, method = "PATCH") {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/pet", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, tz }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Não foi possível salvar.");
      setPet(data.pet); setHasPet(true); setClock(Date.parse(data.pet.updatedAt));
      setMessage(method === "POST" ? "Seu novo amigo chegou! Cuide dele com carinho." : "Prontinho! Progresso salvo.");
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sem conexão. Reconecte para salvar seu progresso.");
      return false;
    } finally { setBusy(false); }
  }

  async function perform(action: PetAction) {
    if (!ACTIONS.includes(action)) return;
    const refused = blockedFor(action);
    if (refused) { setMessage(refused); return; }
    if (!authenticated) {
      setPet((previous) => applyAction(previous, action));
      setMessage("Você está no modo demonstração. Crie sua conta para salvar a aventura.");
    } else if (!hasPet || !(await mutate({ action }))) return;
    setEffect(action);
    setTimeout(() => setEffect(""), 1200);
  }

  function chooseTheme(next: ThemeName) {
    setTheme(next); setPetColor(THEMES[next].pet); setBackgroundColor(THEMES[next].sky);
  }

  const css = { "--world-sky": backgroundColor, "--world-ground": themeConfig.ground, "--world-accent": themeConfig.accent, "--world-dim": themeConfig.night ? 0 : dim } as CSSProperties;

  return (
    <div className="site-shell">
      <header className="site-header">
        <Link href="/" className="brand" aria-label="BeMagic Pets, início"><span className="brand-mark"><PawPrint size={23} /></span><span>bemagic<span className="brand-pets">pets</span><span className="brand-dot">✦</span></span></Link>
        <nav aria-label="Navegação principal"><a href="#como-funciona">Como funciona</a><a href="#configuracoes">Configurações</a></nav>
        {authenticated ? <Button variant="outline" size="sm" onClick={() => void signOut({ callbackUrl: "/" })}><LogOut /> Sair</Button> : <Button asChild size="sm"><a href="#conta">Meu cantinho <ArrowRight /></a></Button>}
      </header>

      <main>
        <section className="hero">
          <div className="hero-label"><span className="status-dot" /> UM POUQUINHO DE MAGIA NO SEU DIA</div>
          <h1>Um pequeno mundo.<br />Um <span>grande amigo.</span><Sparkles className="hero-sparkle" aria-hidden /></h1>
          <p>Alimente, brinque e cuide do seu companheiro pixel.<br className="hidden sm:block" /> Uma amizade que cresce a cada pequeno cuidado.</p>
          <a href="#seu-pet" className="hero-link">Conheça seu novo amigo <ArrowDown size={15} /></a>
          <div className="hero-decoration star-one" aria-hidden>✧</div><div className="hero-decoration star-two" aria-hidden>✦</div>
        </section>

        {verification && <p className="notice" role="status">{verification}</p>}
        {verificationToken && <VerifyAccount token={verificationToken} />}
        <div id="seu-pet" className="game-heading">
          <div><span className="eyebrow">SEU CANTINHO DE FELICIDADE</span><h2>{authenticated ? "Que bom ter você por aqui!" : "Conheça a Pipoca"}</h2></div>
          <span className="mode-tag"><span className="status-dot" /> {authenticated ? hasPet ? "Progresso na nuvem" : "Pronto para adotar" : "Modo demonstração"}</span>
        </div>

        <section className="game-grid" aria-label="Seu pet e cuidados">
          <Card className="pet-card">
            <div className="world-toolbar"><span><span className="status-dot" /> {themeConfig.name}</span><span>{isNight ? <Moon size={15} /> : <Sun size={15} />} {isNight ? "Noite mágica" : dim > 0 ? "Entre dia e noite" : "Um lindo dia"}</span></div>
            <div className={`pet-world ${isNight ? "night" : ""}`} style={css}>
              <div className="world-sun" /><div className="cloud cloud-one" /><div className="cloud cloud-two" />
              <div className="world-mountain mountain-one" /><div className="world-mountain mountain-two" />
              <div className="world-ground" /><div className="pixel-flower flower-one">✿</div><div className="pixel-flower flower-two">✿</div><div className="pixel-flower flower-three">✿</div>
              {!asleep && (speaking || effect) && <div className="pet-bubble">{effect === "feed" ? "Nhac, nhac! ♡" : effect === "play" ? "Uhuu! ✦" : effect === "sleep" ? "Zzz… ✧" : effect === "clean" ? "Plim! ✨" : wantText}</div>}
              <div className={`pet-sprite ${effect ? "pet-celebrate" : ""}`}><div style={{ transform: `scale(${growth})`, transformOrigin: "bottom center", transition: "transform 1s" }}>{asleep && <div className="zzz" aria-hidden><span>z</span><span>Z</span><span>Z</span></div>}<PixelPet color={petColor} sleepy={asleep || effect === "sleep"} /><div className="pet-shadow" /></div></div>
              <div className="world-caption"><Leaf size={12} /> Aqui, os pequenos momentos importam.</div>
            </div>
            <div className="pet-profile"><div><h3>{authenticated && hasPet ? pet.name : "Pipoca"} <Heart size={17} /></h3><p>{authenticated && hasPet ? `${personality.name} · companheiro desde ${new Date(pet.createdAt).toLocaleDateString("pt-BR")}` : "Seu futuro companheiro de aventuras"}</p></div><span className="mood-tag" role="status">{statusText}</span></div>
          </Card>

          <div className="care-column">
            <Card>
              <CardHeader><div className="section-title"><CardTitle>Um carinho faz a diferença</CardTitle><Heart size={17} /></div><p className="muted text-sm">Como seu pequeno amigo está se sentindo.</p></CardHeader>
              <CardContent className="stats-list">
                {[
                  { name: "Barriguinha", value: stats.hunger, icon: Apple, cls: "stat-peach" },
                  { name: "Felicidade", value: stats.happiness, icon: Heart, cls: "stat-pink" },
                  { name: "Energia", value: stats.energy, icon: Zap, cls: "stat-purple" },
                  { name: "Limpeza", value: stats.cleanliness, icon: Droplets, cls: "stat-blue" },
                ].map(({ name, value, icon: Icon, cls }) => <div key={name} className={`stat ${cls}`}><div><span><Icon size={14} /> {name}</span><span>{Math.round(value)}<small>/100</small></span></div><div className="stat-track" role="progressbar" aria-label={name} aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${value}%` }} /></div></div>)}
              </CardContent>
            </Card>
            <div className="care-actions">
              {care.map(({ action, label, hint, icon: Icon, color }) => <button key={action} className={`care-button ${color}`} disabled={busy || loading || (authenticated && !hasPet) || !!blockedFor(action)} onClick={() => void perform(action)}><span className="care-icon"><Icon size={22} /></span><strong>{label}</strong><small>{hint}</small></button>)}
            </div>
            <p className="care-note"><Heart size={13} /> Sem pressa, sem competição. Só cuidado.</p>
          </div>
        </section>
        <p className="game-message" role="status">{loading ? "Buscando seu pequeno amigo…" : message || (asleep ? `${authenticated && hasPet ? pet.name : "Pipoca"} está dormindo e acorda por volta das ${wakeTime}. Shhh…` : null) || (authenticated && hasPet ? "Seu pet continua precisando de cuidados mesmo quando você sai. Um cuidado a cada 10 segundos." : "Experimente os cuidados e as cores. Seu pet de verdade espera por você!")}</p>

        {authenticated && !hasPet && !loading && <Card className="adopt-card"><CardHeader><CardTitle>Como vai se chamar seu novo amigo?</CardTitle></CardHeader><CardContent><form className="adopt-form" onSubmit={(event) => { event.preventDefault(); void mutate({ name: petName || "Pipoca", theme, petColor, backgroundColor }, "POST"); }}><Input aria-label="Nome do pet" value={petName} onChange={(event) => setPetName(event.target.value)} placeholder="Pipoca" minLength={1} maxLength={24} /><Button disabled={busy}><PawPrint /> Adotar meu pet</Button></form></CardContent></Card>}

        <section id="configuracoes" className="customize-section">
          <div className="customize-heading"><span className="palette-badge"><Palette size={21} /></span><div><h2>Seu mundo, suas cores.</h2><p>Uma pitada do seu estilo deixa tudo mais especial.</p></div><span className="tiny-label">FEITO DO SEU JEITINHO</span></div>
          <div className="theme-options" role="group" aria-label="Temas do cenário">
            {(Object.keys(THEMES) as ThemeName[]).map((key) => <button key={key} aria-pressed={theme === key} className={`theme-option ${theme === key ? "selected" : ""}`} onClick={() => chooseTheme(key)}><span className="theme-preview" style={{ background: THEMES[key].sky, borderBottomColor: THEMES[key].ground }}><span style={{ background: THEMES[key].pet }} />{theme === key && <span className="theme-check"><Check size={12} /></span>}</span><span>{THEMES[key].name}</span></button>)}
          </div>
          <div className="color-settings">
            <label><input type="color" value={petColor} onChange={(event) => setPetColor(event.target.value)} /><span>Cor do seu pet<small>{petColor.toUpperCase()}</small></span></label>
            <label><input type="color" value={backgroundColor} onChange={(event) => setBackgroundColor(event.target.value)} /><span>Cor do cenário<small>{backgroundColor.toUpperCase()}</small></span></label>
            <Button variant="ghost" size="sm" onClick={() => chooseTheme(theme)}><RotateCcw /> Restaurar tema</Button>
            {authenticated && hasPet && <Button size="sm" disabled={busy} onClick={() => void mutate({ theme, petColor, backgroundColor })}><Check /> Salvar meu estilo</Button>}
          </div>
        </section>

        <section id="como-funciona" className="how-section">
          <span className="eyebrow">UM MUNDO SIMPLES. UMA AMIZADE ESPECIAL.</span>
          <h2>Felicidade em pequenos pixels.</h2>
          <div className="how-grid">
            <article><span className="how-icon peach"><PawPrint /></span><h3>01. Encontre seu amigo</h3><p>Crie uma conta, confirme seu email e dê um nome ao seu companheiro.</p></article>
            <article><span className="how-icon purple"><Star /></span><h3>02. Cuide com carinho</h3><p>Comidinha, brincadeiras, descanso e banho. Cada cuidado faz a diferença.</p></article>
            <article><span className="how-icon mint"><Palette /></span><h3>03. Faça do seu jeito</h3><p>Escolha suas cores, instale no celular e ative lembretes se quiser.</p></article>
          </div>
        </section>

        {!authenticated && <AccountPanel />}
        {authenticated && <p className="signed-in">Seu cantinho está conectado como {session?.user?.email}.</p>}
        <PwaControls authenticated={authenticated} accountId={session?.user?.id} />
      </main>

      <footer><Link href="/" className="brand"><PawPrint size={18} /> bemagic<span className="brand-pets">pets</span></Link><p>Feito de pixels, magia e um montão de carinho.</p><span>Um pequeno cuidado por vez <Heart size={13} /></span></footer>
    </div>
  );
}
