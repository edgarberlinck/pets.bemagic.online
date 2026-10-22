"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

type InstallPrompt = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function applicationKey(value: string): ArrayBuffer {
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (character) => character.charCodeAt(0)).buffer;
}

export async function browserPushOwnedByAccount(
  registration: ServiceWorkerRegistration, signal: AbortSignal, accountId?: string,
) {
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return false;
  const response = await fetch("/api/push", {
    credentials: "same-origin", cache: "no-store", signal,
    headers: accountId ? { "X-Push-Account": accountId } : undefined,
  });
  if (!response.ok) throw new Error("Não foi possível verificar os lembretes desta conta. Tente novamente.");
  const body = await response.json();
  return (!accountId || body.accountId === accountId) &&
    Array.isArray(body.endpoints) && body.endpoints.includes(subscription.endpoint);
}

export async function enrollBrowserPush(
  registration: ServiceWorkerRegistration, publicKey: string,
  assertCurrentAccount: () => void, signal: AbortSignal, accountId?: string,
) {
  let created: PushSubscription | null = null;
  const subscribe = async () => {
    assertCurrentAccount();
    created = await registration.pushManager.subscribe({
      userVisibleOnly: true, applicationServerKey: applicationKey(publicKey),
    });
    assertCurrentAccount();
    return created;
  };
  const save = async (subscription: PushSubscription) => {
    assertCurrentAccount();
    return fetch("/api/push", {
      method: "POST", headers: {
        "Content-Type": "application/json", ...(accountId ? { "X-Push-Account": accountId } : {}),
      },
      credentials: "same-origin", body: JSON.stringify(subscription.toJSON()), signal,
    });
  };
  try {
    let subscription = await registration.pushManager.getSubscription();
    assertCurrentAccount();
    if (!subscription) subscription = await subscribe();
    let response = await save(subscription);
    assertCurrentAccount();
    if (response.status === 409 && !created) {
      const body = await response.json();
      assertCurrentAccount();
      if (body.code === "endpoint_owned") {
        // Only an explicit opt-in rotates another account's browser subscription.
        // Its database record is never transferred or deleted by this account.
        if (!await subscription.unsubscribe()) throw new Error("Não foi possível preparar este dispositivo.");
        assertCurrentAccount();
        subscription = await subscribe();
        response = await save(subscription);
        assertCurrentAccount();
      }
    }
    if (!response.ok)
      throw new Error(response.status === 429 ? "Muitas tentativas. Tente mais tarde." :
        "Não foi possível ativar. Confirme sua conta e tente novamente.");
  } catch (error) {
    if (created) await (created as PushSubscription).unsubscribe().catch(() => false);
    throw error;
  }
}

export function PwaControls({ authenticated, accountId }: { authenticated: boolean; accountId?: string }) {
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [ios, setIos] = useState(false);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [subscribedAccount, setSubscribedAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const vapid = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const accountKey = authenticated ? accountId ?? "current-account" : null;
  const subscribed = !!accountKey && subscribedAccount === accountKey;
  const currentAccount = useRef(accountKey);
  const ownershipRequest = useRef<AbortController | null>(null);
  const mutationRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    currentAccount.current = accountKey;
    return () => {
      currentAccount.current = null;
      mutationRequest.current?.abort();
    };
  }, [accountKey]);

  useEffect(() => {
    const controller = new AbortController();
    ownershipRequest.current = controller;
    const reconcile = async () => {
      setSubscribedAccount(null);
      setMessage("");
      if (!accountKey || !registration || !supported) return;
      try {
        const owned = await browserPushOwnedByAccount(registration, controller.signal, accountId);
        if (!controller.signal.aborted) setSubscribedAccount(owned ? accountKey : null);
      } catch {
        if (!controller.signal.aborted)
          setMessage("Não foi possível verificar os lembretes desta conta. Tente ativar novamente.");
      }
    };
    void reconcile();
    return () => controller.abort();
  }, [accountId, accountKey, registration, supported]);

  useEffect(() => {
    let active = true;
    const display = window.matchMedia("(display-mode: standalone)");
    const updateDisplay = () => setStandalone(display.matches ||
      !!(navigator as Navigator & { standalone?: boolean }).standalone);
    const beforeInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPrompt);
    };
    const installed = () => { setStandalone(true); setInstallPrompt(null); };
    const initialize = async () => {
      updateDisplay();
      setIos(/iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
      const capable = window.isSecureContext && "serviceWorker" in navigator &&
        "PushManager" in window && "Notification" in window;
      setSupported(capable);
      if (!window.isSecureContext || !("serviceWorker" in navigator)) return;
      try {
        const registered = await navigator.serviceWorker.register("/sw.js", {
          scope: "/", updateViaCache: "none",
        });
        if (!active) return;
        setRegistration(registered);
      } catch {
        if (active) setMessage("Não foi possível preparar o aplicativo. Tente recarregar a página.");
      }
    };
    void initialize();
    window.addEventListener("beforeinstallprompt", beforeInstall);
    window.addEventListener("appinstalled", installed);
    display.addEventListener("change", updateDisplay);
    return () => {
      active = false;
      window.removeEventListener("beforeinstallprompt", beforeInstall);
      window.removeEventListener("appinstalled", installed);
      display.removeEventListener("change", updateDisplay);
    };
  }, []);

  async function install() {
    if (!installPrompt) return;
    setBusy(true);
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      setMessage(choice.outcome === "accepted" ? "Aplicativo adicionado!" : "Você pode instalar depois.");
      setInstallPrompt(null);
    } catch { setMessage("Não foi possível instalar. Use o menu do navegador."); }
    finally { setBusy(false); }
  }

  async function togglePush() {
    if (!registration || !accountKey || !supported) return;
    ownershipRequest.current?.abort();
    const controller = new AbortController();
    mutationRequest.current = controller;
    const assertCurrentAccount = () => {
      if (controller.signal.aborted || currentAccount.current !== accountKey)
        throw new Error("A conta mudou. Tente novamente.");
    };
    setBusy(true);
    setMessage("");
    try {
      const subscription = await registration.pushManager.getSubscription();
      assertCurrentAccount();
      if (subscribed && !subscription) {
        setSubscribedAccount(null);
        setMessage("Notificações já desativadas neste navegador.");
        return;
      }
      if (subscribed && subscription) {
        const response = await fetch("/api/push", {
          method: "DELETE", headers: {
            "Content-Type": "application/json", ...(accountId ? { "X-Push-Account": accountId } : {}),
          },
          credentials: "same-origin", body: JSON.stringify({ endpoint: subscription.endpoint }),
          signal: controller.signal,
        });
        assertCurrentAccount();
        if (!response.ok) throw new Error("Não foi possível desativar. Tente novamente.");
        if (!await subscription.unsubscribe()) throw new Error("Tente desativar novamente.");
        assertCurrentAccount();
        setSubscribedAccount(null);
        setMessage("Notificações desativadas neste dispositivo.");
        return;
      }
      if (!vapid) throw new Error("Notificações ainda não configuradas.");
      // Permission is requested only inside this explicit user click.
      const permission = await Notification.requestPermission();
      assertCurrentAccount();
      if (permission !== "granted")
        throw new Error("Permissão não concedida. Você pode alterá-la nas configurações do navegador.");
      if (!registration.active) throw new Error("Aguarde a instalação do aplicativo e tente novamente.");
      await enrollBrowserPush(registration, vapid, assertCurrentAccount, controller.signal, accountId);
      assertCurrentAccount();
      setSubscribedAccount(accountKey);
      setMessage("Notificações ativadas! Avisaremos quando seu pet precisar de carinho.");
    } catch (error) {
      if (currentAccount.current === accountKey && !controller.signal.aborted)
        setMessage(error instanceof Error ? error.message : "Não foi possível alterar as notificações.");
    } finally { setBusy(false); }
  }

  return (
    <section aria-label="Instalar e receber lembretes" className="border-2 border-border bg-card p-6 text-sm text-muted-foreground">
      <h2 className="font-semibold text-foreground">Seu pet sempre pertinho</h2>
      {!standalone && installPrompt && (
        <Button type="button" onClick={install} disabled={busy} className="mt-3">
          Instalar aplicativo
        </Button>
      )}
      {!standalone && !installPrompt && (
        <p className="mt-2">{ios
          ? "No Safari, toque em Compartilhar e Adicionar à Tela de Início. Depois, abra o app para ativar lembretes."
          : "Para instalar, procure “Instalar aplicativo” ou “Adicionar à tela inicial” no menu do navegador."}</p>
      )}
      {standalone && <p className="mt-2">Aplicativo instalado.</p>}
      {!authenticated ? <p className="mt-2">Entre na sua conta para ativar lembretes opcionais.</p>
        : supported === false ? <p className="mt-2">Este navegador não oferece notificações aqui. {ios ? "Instale na tela inicial e abra o aplicativo." : "Use um navegador compatível em conexão segura."}</p>
        : supported && (
          <Button type="button" variant="outline" onClick={togglePush} disabled={busy || !registration || (!vapid && !subscribed)}
            aria-pressed={subscribed}
            className="mt-3 text-foreground">
            {busy ? "Aguarde…" : subscribed ? "Desativar notificações" : "Ativar notificações"}
          </Button>
        )}
      {authenticated && supported && !vapid && <p className="mt-2">Lembretes ainda não configurados pelo serviço.</p>}
      <p role="status" aria-live="polite" className="mt-2">{message}</p>
    </section>
  );
}
