import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initScrollReveal } from "./lib/scrollReveal";
import { applyTheme } from "./lib/theme";
import { useUIStore } from "./stores/ui";
import "./styles/globals.css";

initScrollReveal();
// Apply the persisted theme before the first paint to avoid a light→dark flash
// (the store reads the saved choice from localStorage on creation).
applyTheme(useUIStore.getState().theme);

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element #root not found");

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
