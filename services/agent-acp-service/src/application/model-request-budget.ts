export class ModelRequestLimitError extends Error {
  public constructor() {
    super("Run model request budget exhausted");
    this.name = "ModelRequestLimitError";
  }
}

export class ModelRequestBudget {
  private used = 0;
  public constructor(private readonly maximum: number) {}
  public canTake(reserve = 0): boolean {
    return this.used < this.maximum - reserve;
  }
  public nextAttempt(reserve = 0): number {
    if (!this.canTake(reserve)) throw new ModelRequestLimitError();
    this.used += 1;
    return this.used;
  }
  public take(reserve = 0): boolean {
    if (!this.canTake(reserve)) return false;
    this.nextAttempt(reserve);
    return true;
  }
}
