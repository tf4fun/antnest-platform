// Session completion is published only after actual resources have joined.
export async function joinSessionFaults(operations) {
  const settled = await Promise.allSettled(
    operations.map((operation) => Promise.resolve().then(operation)),
  );
  const errors = settled
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(errors, "Session fault observations failed");
  return settled.map((result) => result.value);
}

export async function runSessionBusiness({ run, cleanup, publish }) {
  const errors = [];
  let business, closed;
  try {
    business = await run();
  } catch (error) {
    errors.push(error);
  }
  try {
    closed = await cleanup();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(errors, "Session business and cleanup failed");
  return publish(business, closed);
}
