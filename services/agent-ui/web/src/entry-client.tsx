import "./browser-validation";
import { createRoot, hydrateRoot } from "react-dom/client";
import BridgeApp from "./BridgeApp";
import type { WorkspaceRoute } from "./lib/navigation";
import "./styles.css";

const payload = document.getElementById("workspace-bootstrap")?.textContent;
const initial = payload ? JSON.parse(payload) as {
  bootstrap: unknown;
  route: WorkspaceRoute;
} : { bootstrap: null, route: { agentId: "", sessionId: null } };
const root = document.getElementById("root");
if (root) {
  const app = <BridgeApp
    initialBootstrap={initial.bootstrap ?? undefined}
    initialRoute={initial.route}
  />;
  if (root.dataset.ssr === "fallback") createRoot(root).render(app);
  else hydrateRoot(root, app);
}
