import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";
import { readPreferences, applyPreferences } from "./preferences.ts";

applyPreferences(readPreferences());

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element");
createRoot(root).render(<StrictMode><App /></StrictMode>);
