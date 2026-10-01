import type { ErrorObject, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";

import type { ModelToolDefinition } from "../domain/types.js";
import type { ModelToolCall } from "../ports/model.js";

export type PreparedToolCall = {
  call: ModelToolCall;
  tool: ModelToolDefinition;
};

export type RejectedToolCall = {
  call: ModelToolCall;
  message: string;
};

export type ToolBatchPreflight =
  { kind: "ready"; calls: PreparedToolCall[] } | { kind: "rejected"; calls: RejectedToolCall[] };

export class ToolPreflightError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ToolPreflightError";
  }
}

export class ToolPreflight {
  private readonly ajv = new Ajv2020({ allErrors: true, strict: false });
  private readonly validators = new Map<string, ValidateFunction>();

  public inspect(
    calls: readonly ModelToolCall[],
    tools: readonly ModelToolDefinition[],
  ): ToolBatchPreflight {
    assertUniqueCallIds(calls);
    const prepared = calls.map((call) => this.inspectOne(call, tools));
    if (prepared.every(isPrepared)) {
      return { kind: "ready", calls: prepared };
    }
    return {
      kind: "rejected",
      calls: prepared.map((item) =>
        isPrepared(item)
          ? {
              call: item.call,
              message:
                "Tool call was not executed because another call in the same response was invalid.",
            }
          : item,
      ),
    };
  }

  private inspectOne(
    call: ModelToolCall,
    tools: readonly ModelToolDefinition[],
  ): PreparedToolCall | RejectedToolCall {
    const tool = tools.find((candidate) => candidate.modelName === call.name);
    if (tool === undefined) {
      return { call, message: `Unknown Tool: ${call.name}` };
    }
    const schema = tool.inputSchema;
    if (schema === undefined) {
      return { call, tool };
    }
    const validator = this.validator(tool.modelName, schema);
    if (validator(call.arguments)) {
      return { call, tool };
    }
    return {
      call,
      message: `Tool arguments do not match the declared schema: ${formatErrors(validator.errors)}`,
    };
  }

  private validator(
    modelName: string,
    schema: Exclude<ModelToolDefinition["inputSchema"], undefined>,
  ): ValidateFunction {
    const key = JSON.stringify(schema);
    const cached = this.validators.get(key);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const compiled = this.ajv.compile(schema);
      this.validators.set(key, compiled);
      return compiled;
    } catch (error) {
      throw new ToolPreflightError(
        "invalid_tool_schema",
        `Tool ${modelName} published an invalid input schema`,
        { cause: error },
      );
    }
  }
}

function isPrepared(call: PreparedToolCall | RejectedToolCall): call is PreparedToolCall {
  return "tool" in call;
}

function assertUniqueCallIds(calls: readonly ModelToolCall[]): void {
  const ids = new Set<string>();
  for (const call of calls) {
    if (ids.has(call.id)) {
      throw new ToolPreflightError(
        "duplicate_tool_call_id",
        `Model returned duplicate Tool call ID ${call.id}`,
      );
    }
    ids.add(call.id);
  }
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (errors === null || errors === undefined || errors.length === 0) {
    return "validation failed";
  }
  return errors
    .slice(0, 3)
    .map((error) => {
      if (error.keyword === "additionalProperties")
        return `${error.instancePath}/${pointerField(String(error.params.additionalProperty))} is not allowed`;
      if (error.keyword === "required")
        return `${error.instancePath}/${pointerField(String(error.params.missingProperty))} is required`;
      return `${error.instancePath || "/"} ${error.message ?? "is invalid"}`;
    })
    .join("; ");
}

function pointerField(value: string): string {
  return value.slice(0, 120).replaceAll("~", "~0").replaceAll("/", "~1");
}
