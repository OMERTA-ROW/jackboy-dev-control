// Browser side of phone alerts: asks this device for notification permission and returns its push token.
// Must be called from a button press. Never registers inside the editor preview frame.
export type PushResult =
  | { status: "registered"; token: string }
  | { status: "not-configured" | "unsupported" | "open-in-new-tab" | "denied" | "ios-home-screen" };

const env = import.meta.env as Record<string, string | undefined>;
const appId = env["VITE_LOVABLE_CONNECTOR_FIREBASE_MESSAGING_APP_ID"];
const vapidKey = env["VITE_LOVABLE_CONNECTOR_FIREBASE_MESSAGING_VAPID_KEY"];
const firebaseConfig = {
  apiKey: env["VITE_LOVABLE_CONNECTOR_FIREBASE_MESSAGING_WEB_API_KEY"] ?? "",
  projectId: env["VITE_LOVABLE_CONNECTOR_FIREBASE_MESSAGING_PROJECT_ID"] ?? "",
  appId: appId ?? "",
  messagingSenderId: appId?.split(":")[1] ?? "",
};

export const pushWebConfigured = () => Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && appId && vapidKey && firebaseConfig.messagingSenderId);

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

export async function enablePush(): Promise<PushResult> {
  if (!pushWebConfigured()) return { status: "not-configured" };
  if (window.top !== window.self) return { status: "open-in-new-tab" };
  if (iosNeedsHomeScreen()) return { status: "ios-home-screen" };
  const { getMessaging, getToken, isSupported } = await import("firebase/messaging");
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !(await isSupported())) return { status: "unsupported" };
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") return { status: "denied" };
  const { initializeApp, getApps } = await import("firebase/app");
  const query = new URLSearchParams(firebaseConfig).toString();
  const serviceWorkerRegistration = await navigator.serviceWorker.register(`/firebase-messaging-sw.js?${query}`);
  const app = getApps()[0] ?? initializeApp(firebaseConfig);
  const token = await getToken(getMessaging(app), { vapidKey, serviceWorkerRegistration });
  return token ? { status: "registered", token } : { status: "denied" };
}

export const PUSH_STATUS_TEXT: Record<Exclude<PushResult["status"], "registered">, string> = {
  "not-configured": "Push isn't connected yet. Finish the Firebase connection first.",
  unsupported: "This browser can't receive push notifications. Try Chrome, Edge, Firefox or Safari on a recent system.",
  "open-in-new-tab": "Open Jackboy in its own tab (or the published site) to turn on alerts. The editor preview can't ask for permission.",
  denied: "Notifications are blocked for this site. Allow them in your browser's site settings, then try again.",
  "ios-home-screen": "On iPhone: tap Share → Add to Home Screen, open Jackboy from the new icon, then press this button again.",
};
