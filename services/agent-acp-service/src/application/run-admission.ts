import { DomainError } from "../domain/errors.js";
import { AgentControllerError } from "../ports/agent-controller.js";

export function isDefinitiveAdmissionRejection(error: unknown): boolean {
  return error instanceof AgentControllerError && error.code !== "dependency_unavailable";
}

export function admissionErrorClass(error: unknown): string {
  return error instanceof DomainError || error instanceof AgentControllerError
    ? error.code
    : "admission_failed";
}
