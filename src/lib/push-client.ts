// Browser side of phone alerts: asks this device for notification permission and returns its push token.
// Must be called from a button press (opt-in only). Never registers inside the editor preview frame.
// Uses Firebase project jackboy-b6bb5; the config arrives from the server for the signed-in owner.
import type { FirebaseWebConfig } from "./firebase-config";

export type PushResult =
  | { status: "registered"; token: string }
  | { status: "not-configured" | "unsupported" | "open-in-new-tab" | "denied" | "ios-home-screen" }
  | { status: "error"; message: string };

/** iPhone/iPad only allow web push from a site added to the Home Screen. */
export function iosNeedsHomeScreen(): boolean {
  if (typeof navigator === "undefined") return false;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  return ios && !standalone;
}

export function deviceLabel(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const kind = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android phone" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows PC" : "This device";
  return `${kind} · added ${new Date().toLocaleDateString()}`;
}

/** Turns Firebase's error codes into plain words. */
function explain(e: unknown): string {
  const code = (e as { code?: string })?.code ?? "";
  const msg = e instanceof Error ? e.message : String(e);
  if (/api-key|API key not valid|installations\/request-failed/i.test(code + msg)) return "Firebase rejected the web API key. Check GOOGLE_API_KEY is the Web API key of project jackboy-b6bb5 and that it allows this site.";
  if (/token-subscribe-failed|vapid|applicationServerKey/i.test(code + msg)) return "Firebase rejected the push key. Check FIREBASE_VAPID_KEY is the Web Push certificate key pair of jackboy-b6bb5.";
  if (/permission-blocked|permission-default/i.test(code)) return "Notifications are blocked for this site in your browser settings.";
  if (/failed-service-worker-registration|ServiceWorker/i.test(code + msg)) return "The browser couldn't start the push helper. Reload the page and try again.";
  return `Firebase couldn't register this device: ${msg.slice(0, 200)}`;
}

export async function enablePush(cfg: FirebaseWebConfig | null): Promise<PushResult> {
  if (!cfg?.apiKey || !cfg.vapidKey) return { status: "not-configured" };
  if (window.top !== window.self) return { status: "open-in-new-tab" };
  if (iosNeedsHomeScreen()) return { status: "ios-home-screen" };
  try {
    const { getMessaging, getToken, isSupported } = await import("firebase/messaging");
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !(await isSupported())) return { status: "unsupported" };
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission !== "granted") return { status: "denied" };
    const { initializeApp, getApps } = await import("firebase/app");
    const web = { apiKey: cfg.apiKey, authDomain: cfg.authDomain, projectId: cfg.projectId, storageBucket: cfg.storageBucket, messagingSenderId: cfg.messagingSenderId, appId: cfg.appId };
    const serviceWorkerRegistration = await navigator.serviceWorker.register(`/firebase-messaging-sw.js?${new URLSearchParams(web).toString()}`);
    const app = getApps()[0] ?? initializeApp(web);
    const token = await getToken(getMessaging(app), { vapidKey: cfg.vapidKey, serviceWorkerRegistration });
    return token ? { status: "registered", token } : { status: "error", message: "Firebase returned no device token." };
  } catch (e) {
    return { status: "error", message: explain(e) };
  }
}

export const PUSH_STATUS_TEXT: Record<Exclude<PushResult["status"], "registered" | "error">, string> = {
  "not-configured": "Push isn't fully set up yet: the Firebase web key or the push (VAPID) key is missing.",
  unsupported: "This browser can't receive push notifications. Try Chrome, Edge, Firefox or Safari on a recent system.",
  "open-in-new-tab": "Open Jackboy in its own tab (or the published site) to turn on alerts. The editor preview can't ask for permission.",
  denied: "Notifications are blocked for this site. Allow them in your browser's site settings, then try again.",
  "ios-home-screen": "On iPhone: tap Share → Add to Home Screen, open Jackboy from the new icon, then press this button again.",
};
export function pushResultText(r: Exclude<PushResult, { status: "registered" }>): string {
  return r.status === "error" ? r.message : PUSH_STATUS_TEXT[r.status];
}
