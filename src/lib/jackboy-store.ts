import { useSyncExternalStore } from "react";

export type Mode = "classic" | "assist";
export type LogLevel = "info" | "success" | "error" | "approval";
export type LogEntry = { id: string; at: string; level: LogLevel; message: string };
export type Suggestion = {
  id: string;
  title: string;
  detail: string;
  status: "pending" | "approved" | "dismissed";
};

export type JackboyState = {
  mode: Mode;
  guidance: boolean; // opt-in contextual guidance
  learnUsage: boolean; // opt-in adaptive suggestions
  usage: Record<string, number>;
  pinned: string[]; // panel order — only changed after approval
  suggestions: Suggestion[];
  logs: LogEntry[];
};

export const DEFAULT_PANELS = ["status", "builds", "services", "activity"];

const KEY = "jackboy:v1";
const initial: JackboyState = {
  mode: "classic",
  guidance: false,
  learnUsage: false,
  usage: {},
  pinned: DEFAULT_PANELS,
  suggestions: [],
  logs: [
    { id: "seed", at: new Date(0).toISOString(), level: "info", message: "Jackboy initialised in read-only mode (demo data)." },
  ],
};

let state: JackboyState = initial;
let loaded = false;
const listeners = new Set<() => void>();

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) state = { ...initial, ...JSON.parse(raw) };
  } catch {
    /* ignore corrupt storage */
  }
}

function emit() {
  if (typeof window !== "undefined") localStorage.setItem(KEY, JSON.stringify(state));
  listeners.forEach((l) => l());
}

export function setState(fn: (s: JackboyState) => JackboyState) {
  load();
  state = fn(state);
  emit();
}

export function log(level: LogLevel, message: string) {
  setState((s) => ({
    ...s,
    logs: [{ id: crypto.randomUUID(), at: new Date().toISOString(), level, message }, ...s.logs].slice(0, 200),
  }));
}

/** Record usage only when the user opted in; may propose (never apply) a layout suggestion. */
export function trackUse(panel: string) {
  load();
  if (!state.learnUsage) return;
  setState((s) => {
    const usage = { ...s.usage, [panel]: (s.usage[panel] ?? 0) + 1 };
    const suggestions = [...s.suggestions];
    const id = `pin-${panel}`;
    const idx = s.pinned.indexOf(panel);
    if (usage[panel] >= 3 && idx > 0 && !suggestions.some((x) => x.id === id)) {
      suggestions.push({
        id,
        title: `Move “${panel}” to the top?`,
        detail: `You opened this panel ${usage[panel]} times. Nothing moves unless you approve.`,
        status: "pending",
      });
    }
    return { ...s, usage, suggestions };
  });
}

export function resolveSuggestion(id: string, approve: boolean) {
  setState((s) => {
    const sug = s.suggestions.find((x) => x.id === id);
    if (!sug) return s;
    let pinned = s.pinned;
    if (approve && id.startsWith("pin-")) {
      const panel = id.slice(4);
      pinned = [panel, ...s.pinned.filter((p) => p !== panel)];
    }
    return {
      ...s,
      pinned,
      suggestions: s.suggestions.map((x) => (x.id === id ? { ...x, status: approve ? "approved" : "dismissed" } : x)),
    };
  });
  log("approval", `${approve ? "Approved" : "Dismissed"} suggestion: ${id}`);
}

const serverSnap = () => initial;
export function useJackboy(): JackboyState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      if (!loaded) {
        load();
        queueMicrotask(l);
      }
      return () => listeners.delete(l);
    },
    () => state,
    serverSnap,
  );
}
