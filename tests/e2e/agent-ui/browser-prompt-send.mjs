export async function sendBrowserPrompt({
  page,
  composer,
  phase,
  matchesResponse,
  poll,
}) {
  await composer.fill(phase);
  const submit = page.getByRole("button", {
    name: "Send message",
    exact: true,
  });
  await poll(
    async () => (await submit.isVisible()) && (await submit.isEnabled()),
    `${phase}: Prompt admission`,
  );
  const pending = page.waitForResponse(matchesResponse, { timeout: 30_000 });
  // Observe rejection before Enter, and join both actual browser operations.
  const observed = pending.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  let pressError;
  try {
    await composer.press("Enter");
  } catch (error) {
    pressError = error;
  }
  const response = await observed;
  if (pressError && response.error)
    throw new AggregateError(
      [pressError, response.error],
      "Prompt browser actions failed",
    );
  if (pressError || response.error) throw pressError ?? response.error;
  return response.value;
}
