export async function openRecoveryWorkspace(
  page,
  { gateway, workspace, role },
) {
  // Member login replaces the Console document with the Workspace chooser.
  // Join that navigation before requesting the original recovery Session.
  if (role === "member")
    await page.waitForURL(new URL("/workspace/", gateway).href, {
      waitUntil: "domcontentloaded",
    });
  await page.goto(new URL(workspace, gateway).href, {
    waitUntil: "domcontentloaded",
  });
}
