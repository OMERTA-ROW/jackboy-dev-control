// Public identifiers of the owner's Firebase project (jackboy-b6bb5). These are publishable web values,
// not credentials. The web API key comes from the GOOGLE_API_KEY backend secret and the VAPID public key
// from FIREBASE_VAPID_KEY, both handed to the signed-in owner by getFirebaseWebConfig.
// Firebase is used only for push notifications; sign-in stays on Jackboy's existing accounts.
export const FIREBASE_PUBLIC = {
  authDomain: "jackboy-b6bb5.firebaseapp.com",
  projectId: "jackboy-b6bb5",
  storageBucket: "jackboy-b6bb5.firebasestorage.app",
  messagingSenderId: "652621974617",
  appId: "1:652621974617:web:223b6617567c1966cdb548",
} as const;

export type FirebaseWebConfig = typeof FIREBASE_PUBLIC & { apiKey: string; vapidKey: string };
export type FirebaseDiagnostics = { apiKey: "ok" | "missing" | "malformed"; vapidKey: "ok" | "missing" | "malformed"; serverSender: boolean };

/** Shape checks only (no network): a Firebase browser key is "AIza" + 35 chars; a VAPID public key is ~87 base64url chars starting with "B". */
export function diagnoseFirebase(apiKey: string | undefined, vapidKey: string | undefined, serverSender: boolean): FirebaseDiagnostics {
  const a = (apiKey ?? "").trim(), v = (vapidKey ?? "").trim();
  return {
    apiKey: !a ? "missing" : /^AIza[\w-]{35}$/.test(a) ? "ok" : "malformed",
    vapidKey: !v ? "missing" : /^B[\w-]{80,100}$/.test(v) ? "ok" : "malformed",
    serverSender,
  };
}
