import type { RuntimeInformation } from "../domain/runtime-information.js";
import type { RunExecutionSnapshot } from "../domain/types.js";

export interface RuntimeInformationPort {
  read(snapshot: RunExecutionSnapshot, signal: AbortSignal): Promise<RuntimeInformation>;
}
