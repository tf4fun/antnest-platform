import { readPrivateExecutionState as readSharedState } from "../../support/private-acp-execution-state.mjs";
import { PrivateACPExecutionStateUnavailableError } from "../../support/private-acp-execution-state-error.mjs";
import { CostExecutionStateUnavailableError } from "./setup.mjs";

// Preserve the existing Cost recovery error contract while sharing the exact
// delegation, complete-response and schema checks with other ACP consumers.
export async function readPrivateExecutionState(...args) {
  try {
    return await readSharedState(...args);
  } catch (error) {
    if (error instanceof PrivateACPExecutionStateUnavailableError)
      throw new CostExecutionStateUnavailableError();
    throw error;
  }
}
