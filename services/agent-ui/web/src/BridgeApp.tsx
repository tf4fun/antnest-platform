import { WorkspacePage } from "./WorkspacePage";
import { useBridgeWorkspace } from "./lib/use-bridge-workspace";
import type { WorkspaceRoute } from "./lib/navigation";

export default function BridgeApp({ initialBootstrap, initialRoute }: {
  initialBootstrap?: unknown;
  initialRoute?: WorkspaceRoute;
} = {}) {
  return <WorkspacePage model={useBridgeWorkspace({ initialBootstrap, initialRoute })} />;
}
