export type AdmissionErrorReceipt = {
  code: number;
  message: string;
  data: {
    code: string;
    retryable: boolean;
    retry_after_ms?: number;
    details?: Record<string, never>;
  };
};

export function assertErrorCapability(initializeResult: unknown): void;
export function admissionErrorReceipt(
  expectedCode: string,
): AdmissionErrorReceipt;
export function assertAdmissionError(
  actual: unknown,
  expectedCode: string,
): asserts actual is AdmissionErrorReceipt;
