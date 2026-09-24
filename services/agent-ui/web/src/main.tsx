import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import BridgeApp from "./BridgeApp";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BridgeApp />
  </StrictMode>,
);
