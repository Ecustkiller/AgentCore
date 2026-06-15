import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initScrollReveal } from "./lib/scrollReveal";
import "./styles/globals.css";

initScrollReveal();

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element #root not found");

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
