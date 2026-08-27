import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@orbit/theme/tokens.css";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Orbit root element was not found.");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
