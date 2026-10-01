import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const webRoot = `${root}services/agent-ui/web`;
const output = `${root}artifacts/verification/skill-learning`;
const requireFromWeb = createRequire(`${webRoot}/package.json`);
const { createServer } = await import(requireFromWeb.resolve("vite"));
const playwright = await import(requireFromWeb.resolve("playwright"));
const chromium = playwright.chromium ?? playwright.default.chromium;
const htmlPath = `${webRoot}/learning-notice-preview.html`;
const entryPath = `${webRoot}/learning-notice-preview.tsx`;
const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Skill learning notice preview</title></head><body><div id="root"></div><script type="module" src="/learning-notice-preview.tsx"></script></body></html>`;
const entry = `import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Menu, Plus, RefreshCw } from "lucide-react";
import { LearningNotices } from "./src/components/LearningNotices";
import { NavigationPanel } from "./src/components/NavigationPanel";
import "./src/styles.css";

const first = { changeId: "change-preview-1", sequence: "1", agentId: "agent-preview", kind: "skill_created" as const,
  occurredAt: "2026-09-29T00:00:00Z", skillName: "release-workflow", changeSummary: "Learned the release workflow", sourceSessionId: "session-preview" };
const second = { changeId: "change-preview-2", sequence: "2", agentId: "agent-preview", kind: "skill_updated" as const,
  occurredAt: "2026-09-29T00:01:00Z", skillName: "release-workflow", changeSummary: "Improved the release workflow", sourceSessionId: "session-preview" };
const loadStatus = async (_signal: AbortSignal) => ({ agentId: "agent-preview", blocked: { reason: "writer_present" as const } });
function Preview() {
  const [items, setItems] = useState([first] as Array<typeof first | typeof second>);
  useEffect(() => { const timer = window.setTimeout(() => setItems([first, second]), 1000); return () => window.clearTimeout(timer); }, []);
  return <div className="app-shell">
    <NavigationPanel open={false} onClose={() => {}}>
      <div style={{padding: "22px 18px"}}>
        <strong style={{fontSize: 18}}>Antnest</strong>
        <p style={{marginTop: 32, fontSize: 13, color: "var(--muted)"}}>Research Agent</p>
        <p style={{fontSize: 13, color: "var(--muted)"}}>Past conversations</p>
      </div>
    </NavigationPanel>
    <main className="workspace-main">
      <header className="workspace-topbar">
        <button className="icon-button mobile-menu" type="button" aria-label="Open navigation"><Menu size={18}/></button>
        <div className="topbar-agent"><div><h1>Research Agent</h1><small>New conversation</small></div><span className="presence presence-ready">Ready</span></div>
        <div className="topbar-actions">
          <LearningNotices agentId="agent-preview" ready notices={items} loadStatus={loadStatus}/>
          <button className="icon-button" type="button" aria-label="Refresh workspace"><RefreshCw size={17}/></button>
          <button className="icon-button topbar-new-conversation" type="button" aria-label="New conversation"><Plus size={17}/></button>
        </div>
      </header>
      <section style={{flex: 1, display: "grid", placeItems: "center", color: "var(--muted)", fontSize: 13}}>
        Start a conversation
      </section>
    </main>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Preview/>);
`;

let server;
let browser;
try {
  await writeFile(htmlPath, html, { flag: "wx" });
  await writeFile(entryPath, entry, { flag: "wx" });
  await mkdir(output, { recursive: true, mode: 0o700 });
  server = await createServer({
    root: webRoot,
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/learning-notice-preview.html`;
  browser = await chromium.launch({ headless: true });

  const desktop = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  });
  await desktop.goto(url);
  await desktop.getByRole("status").waitFor();
  await desktop.getByRole("button", { name: /Skill learning results/ }).click();
  await desktop.locator(".learning-notices-panel").waitFor();
  await desktop.locator(".learning-notices-diagnostic").waitFor();
  await desktop.screenshot({
    path: `${output}/learning-diagnostic-desktop.png`,
  });

  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });
  await mobile.goto(url);
  await mobile.locator(".learning-notices-toast").waitFor();
  const toast = await mobile.locator(".learning-notices-toast").boundingBox();
  assert(
    toast && toast.x >= 0 && toast.x + toast.width <= 390,
    "mobile learning notice must fit the viewport",
  );
  assert(
    await mobile
      .getByRole("button", { name: "Dismiss learning result" })
      .isVisible(),
    "mobile learning notice dismiss button must be visible",
  );
  await mobile.getByRole("button", { name: /Skill learning results/ }).click();
  await mobile.locator(".learning-notices-diagnostic").waitFor();
  const history = await mobile.locator(".learning-notices-panel").boundingBox();
  assert(
    history && history.x >= 0 && history.x + history.width <= 390,
    "mobile learning history must fit the viewport",
  );
  await mobile.screenshot({ path: `${output}/learning-diagnostic-mobile.png` });
  console.log(
    JSON.stringify({
      desktop: `${output}/learning-diagnostic-desktop.png`,
      mobile: `${output}/learning-diagnostic-mobile.png`,
    }),
  );
} finally {
  await browser?.close();
  await server?.close();
  await rm(htmlPath, { force: true });
  await rm(entryPath, { force: true });
}
