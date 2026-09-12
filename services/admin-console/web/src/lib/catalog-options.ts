import { useCallback, useRef, useState } from "react";
import { api } from "./api";
import {
  mergeCatalogOptions,
  type CatalogOptionPage,
  type CatalogPageOptions,
} from "./pagination";
import { resourceFailure, type ResourceFailure } from "./resource-failure";
import type { AgentTemplate, ModelProfile } from "./types";

type CatalogLoader<T> = (options?: CatalogPageOptions) => Promise<CatalogOptionPage<T>>;

type CatalogOptions<T> = {
  items: T[];
  available?: boolean;
  hasMore: boolean;
  pending: boolean;
  failure?: ResourceFailure;
  loadInitial: () => Promise<void>;
  loadMore: () => Promise<void>;
  retry: () => void;
};

const modelKey = (model: ModelProfile) => model.model_profile_id;
const modelEnabled = (model: ModelProfile) => model.enabled;
const templateKey = (template: AgentTemplate) => template.template_id;
const templateEnabled = (template: AgentTemplate) => template.enabled;

export function useModelOptions(): CatalogOptions<ModelProfile> {
  return useCatalogOptions(api.models, modelKey, modelEnabled);
}

export function useTemplateOptions(): CatalogOptions<AgentTemplate> {
  return useCatalogOptions(api.templates, templateKey, templateEnabled);
}

function useCatalogOptions<T>(
  loader: CatalogLoader<T>,
  key: (item: T) => string,
  eligible: (item: T) => boolean,
): CatalogOptions<T> {
  const [items, setItems] = useState<T[]>([]);
  const [nextAfterID, setNextAfterID] = useState<string>();
  const [available, setAvailable] = useState<boolean>();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ResourceFailure>();
  const requestPending = useRef(false);

  const fetchPage = useCallback(async (afterID: string | undefined, replaceItems: boolean) => {
    if (requestPending.current) return;
    requestPending.current = true;
    setPending(true);
    setFailure(undefined);
    try {
      const page = await loader(afterID ? { afterID } : {});
      setItems((current) => mergeCatalogOptions(
        replaceItems ? [] : current,
        page,
        key,
        eligible,
      ).items);
      setNextAfterID(page.next_after_id ?? undefined);
      setAvailable(true);
    } catch (cause) {
      if (replaceItems) setAvailable((current) => current ?? false);
      setFailure(resourceFailure(cause));
    } finally {
      requestPending.current = false;
      setPending(false);
    }
  }, [eligible, key, loader]);

  const loadInitial = useCallback(() => fetchPage(undefined, true), [fetchPage]);
  const loadMore = useCallback(async () => {
    if (!nextAfterID) return;
    await fetchPage(nextAfterID, false);
  }, [fetchPage, nextAfterID]);

  return {
    items,
    available,
    hasMore: Boolean(nextAfterID),
    pending,
    failure,
    loadInitial,
    loadMore,
    retry: () => void (nextAfterID ? loadMore() : loadInitial()),
  };
}
