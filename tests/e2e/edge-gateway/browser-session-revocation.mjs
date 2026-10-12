export async function withSessionRevocationObserver(observe, action) {
  const observer = await observe();
  const errors = [];
  let streams;
  try {
    const at = observer.beforeMutation();
    await action();
    streams = await observer.revoked(at);
  } catch (error) {
    errors.push(error);
  }
  // Cleanup may close transports locally; it must follow the remote evidence.
  // Join it even when the action or observation fails, retaining both failures.
  try {
    await observer.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "Session revocation and cleanup failed");
  return streams;
}
