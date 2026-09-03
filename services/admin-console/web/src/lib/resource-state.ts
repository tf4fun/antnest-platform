import { resourceFailure, type ResourceFailure } from "./resource-failure.ts";

export type ResourceState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; failure: ResourceFailure };

export async function captureResource<T>(load: () => Promise<T>): Promise<ResourceState<T>> {
  try {
    return { status: "ready", data: await load() };
  } catch (cause) {
    return {
      status: "error",
      failure: resourceFailure(cause),
    };
  }
}
