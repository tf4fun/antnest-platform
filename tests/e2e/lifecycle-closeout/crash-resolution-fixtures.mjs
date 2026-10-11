import { attachAdmission } from "../stage3-base/resolve-fixtures.mjs";
import { crashTrace, targetPresent } from "./crash-trace-fixtures.mjs";

export function crashResolutionFixture(
  phase = "before-create",
  source = "cache",
) {
  const business = phase === "before-create" ? crashTrace() : targetPresent();
  return attachAdmission(business, source, "client-console");
}
