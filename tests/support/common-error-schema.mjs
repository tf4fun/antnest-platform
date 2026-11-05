import { readFileSync } from "node:fs";

export function withCommonErrorSchema(validator) {
  validator.addSchema(
    JSON.parse(
      readFileSync(
        new URL("../../contracts/common/error.schema.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  return validator;
}
