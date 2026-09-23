import { AssertionError } from "node:assert";
export async function stateReady(
  read,
  accepts = (state) => state.availability === "ready",
) {
  try {
    return accepts(await read());
  } catch (error) {
    if (
      error instanceof AssertionError &&
      error.actual === 503 &&
      error.expected === 200
    )
      return false;
    throw error;
  }
}
