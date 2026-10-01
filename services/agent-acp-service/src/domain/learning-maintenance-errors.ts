export class LearningPolicyChangedError extends Error {
  public constructor() {
    super("Skill learning policy changed during maintenance");
    this.name = "LearningPolicyChangedError";
  }
}

export class RuntimeMaintenanceUnknownError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeMaintenanceUnknownError";
  }
}

export class RuntimeMaintenancePreviouslyDispatchedError extends Error {
  public constructor(public readonly state: "pending" | "unknown" | "settled") {
    super("Runtime Skill maintenance request has already been dispatched; recover its outcome");
    this.name = "RuntimeMaintenancePreviouslyDispatchedError";
  }
}

export class RuntimeMaintenanceRejectedError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`Runtime Skill maintenance rejected: ${code}`);
    this.name = "RuntimeMaintenanceRejectedError";
  }
}
