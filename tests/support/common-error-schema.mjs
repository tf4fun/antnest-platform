import { readFileSync } from "node:fs";

export function withCommonErrorSchema(validator) {
  for (const name of [
    "error",
    "ids",
    "pagination",
    "precondition",
    "idempotency",
  ])
    validator.addSchema(
      JSON.parse(
        readFileSync(
          new URL(
            `../../contracts/common/${name}.schema.json`,
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );
  return validator;
}
