import { z } from "zod";

export function projectResponse(schema: z.ZodType, input: unknown): unknown {
  return projectCandidate([schema], input);
}

function expand(candidate: z.core.$ZodType, out: z.core.$ZodType[]): void {
  if (candidate instanceof z.ZodUnion) {
    for (const option of candidate.options) expand(option, out);
    return;
  }
  if (
    candidate instanceof z.ZodOptional ||
    candidate instanceof z.ZodNullable ||
    candidate instanceof z.ZodDefault ||
    candidate instanceof z.ZodReadonly ||
    candidate instanceof z.ZodPrefault ||
    candidate instanceof z.ZodCatch
  ) {
    expand(candidate.unwrap(), out);
    return;
  }
  out.push(candidate);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function projectCandidate(candidates: z.core.$ZodType[], input: unknown): unknown {
  const expanded: z.core.$ZodType[] = [];
  for (const candidate of candidates) expand(candidate, expanded);

  if (Array.isArray(input)) {
    const elements = expanded
      .filter((candidate): candidate is z.ZodArray => candidate instanceof z.ZodArray)
      .map((candidate) => candidate.element);
    if (elements.length === 0) return input;
    return input.map((item) => projectCandidate(elements, item));
  }

  if (!isRecord(input)) return input;

  const fields = new Map<string, z.core.$ZodType[]>();
  const recordValues: z.core.$ZodType[] = [];
  let hasObjectShape = false;
  for (const candidate of expanded) {
    if (candidate instanceof z.ZodObject) {
      hasObjectShape = true;
      for (const [name, shape] of Object.entries<z.core.$ZodType>(candidate.shape)) {
        const declared = fields.get(name);
        if (declared === undefined) fields.set(name, [shape]);
        else declared.push(shape);
      }
    } else if (candidate instanceof z.ZodRecord) {
      recordValues.push(candidate.valueType);
    }
  }
  if (!hasObjectShape && recordValues.length === 0) return input;

  const entries: [string, unknown][] = [];
  for (const [key, value] of Object.entries(input)) {
    const declared = fields.get(key);
    if (declared !== undefined) {
      entries.push([key, projectCandidate(declared, value)]);
    } else if (!hasObjectShape && recordValues.length > 0) {
      entries.push([key, projectCandidate(recordValues, value)]);
    }
  }
  return Object.fromEntries(entries);
}
