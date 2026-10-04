import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./widget.css";
import { readPreferences, applyPreferences } from "../preferences.ts";
import { Panel } from "./Panel.tsx";
import { configureAuthTransport, localTokenStore } from "../auth.ts";

// The panel shares the dashboard's origin, so it follows the theme preference, including the system's
// colour scheme (while the preference is "system") and a change made in a dashboard tab.
const applyStoredPreferences = () => applyPreferences(readPreferences());
applyStoredPreferences();
globalThis.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyStoredPreferences);
globalThis.addEventListener("storage", applyStoredPreferences);

// The browser may refuse the session cookie in this cross-site frame; a bearer token kept in the
// frame's own (per-site) storage is the fallback. Storage access is guarded inside the store.
configureAuthTransport(localTokenStore({
  getItem: (key) => globalThis.localStorage.getItem(key),
  setItem: (key, value) => globalThis.localStorage.setItem(key, value),
  removeItem: (key) => globalThis.localStorage.removeItem(key),
}));

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element");
createRoot(root).render(<StrictMode><Panel /></StrictMode>);
