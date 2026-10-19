// Business failure and recovery failure are independent evidence. Always join
// recovery, retaining original Error identities instead of a finally override.
export async function stage2Step(work, cleanup) {
  const errors = [];
  let value;
  try {
    value = await work();
  } catch (error) {
    errors.push(error);
  }
  try {
    await cleanup();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(errors, "Stage2 business and recovery failed");
  return value;
}
