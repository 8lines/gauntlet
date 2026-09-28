import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./widget.css";
import { readPreferences, applyPreferences } from "../preferences.ts";
import { Panel } from "./Panel.tsx";

applyPreferences(readPreferences());

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element");
createRoot(root).render(<StrictMode><Panel /></StrictMode>);
