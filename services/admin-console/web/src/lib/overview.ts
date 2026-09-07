import type { Directory, Overview } from "./types";
import { responseResourceFailure, type ResourceFailure } from "./resource-failure.ts";

export type BoundedSnapshot = {
  count: number;
  hasMore: boolean;
  display: number | string;
};

export function boundedSnapshot(count: number, nextCursor?: string | null): BoundedSnapshot {
  const hasMore = Boolean(nextCursor);
  return {
    count,
    hasMore,
    display: hasMore ? `≥${count}` : count,
  };
}

export type OverviewMetricSummary = {
  value: number | string;
  detail: string;
};

export type OverviewResourceSummary = {
  directory: OverviewMetricSummary;
  models: OverviewMetricSummary;
  templates: OverviewMetricSummary;
  degraded: ResourceFailure[];
};

export function overviewResourceSummary(overview: Overview): OverviewResourceSummary {
  const degraded = [
    overview.agents,
    overview.directory,
    overview.model_profiles,
    overview.templates,
  ].flatMap((section) => section.status === "unavailable"
    ? [responseResourceFailure(section.error.status, section.error.message)]
    : []);

  const directory = overview.directory.status === "available"
    ? activeDirectorySummary(overview.directory.data.users)
    : { value: "—", detail: "Directory unavailable" };
  const models = overview.model_profiles.status === "available"
    ? pagedMetric(
      overview.model_profiles.data.items.length,
      overview.model_profiles.data.next_after_id,
      "Configured model profiles",
      "Loaded model profiles; more available",
    )
    : { value: "—", detail: "Model inventory unavailable" };
  const templates = overview.templates.status === "available"
    ? pagedMetric(
      overview.templates.data.items.length,
      overview.templates.data.next_after_id,
      "Versioned build definitions",
      "Loaded templates; more available",
    )
    : { value: "—", detail: "Template inventory unavailable" };

  return { directory, models, templates, degraded };
}

export function overviewRefreshAllowed(
  failure: ResourceFailure | undefined,
  sectionFailures: ResourceFailure[],
): boolean {
  return failure ? failure.retryable : sectionFailures.some((section) => section.retryable);
}

function activeDirectorySummary(users: Directory["users"]): OverviewMetricSummary {
  const active = users.filter(({ user, membership }) => user.active && membership.active).length;
  const inactive = users.length - active;
  return {
    value: active,
    detail: inactive > 0 ? `${inactive} inactive in directory` : `${users.length} in organization`,
  };
}

function pagedMetric(
  count: number,
  cursor: string | null | undefined,
  completeDetail: string,
  partialDetail: string,
): OverviewMetricSummary {
  const snapshot = boundedSnapshot(count, cursor);
  return {
    value: snapshot.display,
    detail: snapshot.hasMore ? partialDetail : completeDetail,
  };
}
