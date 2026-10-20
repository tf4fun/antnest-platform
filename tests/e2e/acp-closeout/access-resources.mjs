// Finish every owned resource before reporting a scenario failure. The raw
// business, cleanup and archive errors remain distinct original objects.
export async function withCloseoutResources(action, cleanup, preserve) {
  const errors = [];
  let result;
  try {
    result = await action();
  } catch (error) {
    errors.push(error);
  }
  try {
    await cleanup();
  } catch (error) {
    errors.push(error);
  }
  if (!errors.length) return result;
  let failure =
    errors.length === 1
      ? errors[0]
      : new AggregateError(errors, "Closeout business and cleanup failed");
  try {
    await preserve(failure);
  } catch (archiveError) {
    failure = new AggregateError(
      [...errors, archiveError],
      "Closeout failure and private archival failed",
    );
  }
  throw failure;
}
