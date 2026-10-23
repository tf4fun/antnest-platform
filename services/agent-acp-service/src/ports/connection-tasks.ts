/** Connection-owned work ends at raw settlement, independently of caller cancellation. */
export interface ConnectionTaskOwner {
  run<T>(operation: () => T | Promise<T>): Promise<T>;
}
