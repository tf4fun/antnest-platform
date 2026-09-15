import {
  ChevronDown,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  Server,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ListPagination,
  PageHeader,
  ResourceFailureNotice,
  ResourceFailurePage,
  ResourceToolbar,
  SearchField,
} from "../components/page";
import { Badge } from "../components/ui/badge";
import { CatalogAvailabilityControl } from "../components/catalog-availability";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import {
  Empty,
  ErrorNotice,
  Loading,
  SuccessNotice,
} from "../components/ui/feedback";
import { Field, Input } from "../components/ui/input";
import { APIError, api, errorMessage } from "../lib/api";
import { modelCatalogGate, modelInputLabel } from "../lib/model-catalog";
import { mergePage } from "../lib/pagination";
import { resourceFailure, type ResourceFailure } from "../lib/resource-failure";
import { captureResource, type ResourceState } from "../lib/resource-state";
import type {
  ModelCatalog,
  ModelProfile,
  ProviderConnection,
} from "../lib/types";
import { ConnectProvider } from "./connect-provider";
import { ProviderModelDiscovery } from "./provider-model-discovery";

export function ProviderList() {
  const [items, setItems] = useState<ProviderConnection[]>();
  const [failure, setFailure] = useState<ResourceFailure>();
  const [next, setNext] = useState<string>();
  const [pageFailure, setPageFailure] = useState<ResourceFailure>();
  const [paging, setPaging] = useState(false);
  const [catalog, setCatalog] = useState<ResourceState<ModelCatalog>>({
    status: "loading",
  });
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [expanded, setExpanded] = useState<string>();
  const [success, setSuccess] = useState("");
  const load = useCallback(async () => {
    setFailure(undefined);
    try {
      const page = await api.providers();
      setItems(page.items);
      setNext(page.next_after_id ?? undefined);
    } catch (cause) {
      setFailure(resourceFailure(cause));
    }
  }, []);
  const loadCatalog = useCallback(async () => {
    setCatalog({ status: "loading" });
    setCatalog(await captureResource(api.modelCatalog));
  }, []);
  useEffect(() => {
    void load();
    void loadCatalog();
  }, [load, loadCatalog]);
  async function loadMore() {
    if (!next || paging || pageFailure?.retryable === false) return;
    setPaging(true);
    setPageFailure(undefined);
    try {
      const page = await api.providers({ afterID: next });
      setItems((current) =>
        mergePage(current ?? [], page.items, (item) => item.connection_id),
      );
      setNext(page.next_after_id ?? undefined);
    } catch (cause) {
      setPageFailure(resourceFailure(cause));
    } finally {
      setPaging(false);
    }
  }
  function replace(value: ProviderConnection) {
    setItems((current) =>
      (current ?? []).map((item) =>
        item.connection_id === value.connection_id ? value : item,
      ),
    );
  }
  if (!items)
    return failure ? (
      <ResourceFailurePage
        eyebrow="Configuration"
        failure={failure}
        resource="Model provider inventory"
        returnHref="#overview"
        returnLabel="Back to Overview"
        onRetry={() => void load()}
      />
    ) : (
      <Loading label="Loading model providers" />
    );
  const gate = modelCatalogGate(catalog.status);
  const filtered = items.filter((item) =>
    `${item.display_name} ${item.base_url}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const add = (
    <Button
      disabled={!gate.changeAllowed}
      title={gate.message}
      onClick={() => {
        setSuccess("");
        setOpen(true);
      }}
    >
      <Plus className="h-4 w-4" />
      Add provider
    </Button>
  );
  return (
    <div className="grid gap-5">
      <PageHeader
        eyebrow="Configuration"
        title="Model providers"
        detail=""
        actions={add}
      />
      {success ? (
        <SuccessNotice message={success} onDismiss={() => setSuccess("")} />
      ) : null}
      {failure ? (
        <ResourceFailureNotice
          failure={failure}
          retryLabel="Retry model providers"
          onRetry={() => void load()}
        />
      ) : null}
      {catalog.status === "error" ? (
        <ResourceFailureNotice
          failure={catalog.failure}
          message={`Model catalog could not be loaded: ${catalog.failure.message}`}
          retryLabel="Retry model catalog"
          onRetry={() => void loadCatalog()}
        />
      ) : null}
      {!items.length ? (
        <Empty
          title="No model providers"
          detail="Connect a model provider before creating an Agent template."
          action={add}
        />
      ) : (
        <>
          <ResourceToolbar>
            <SearchField
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search providers or endpoints"
            />
            <p className="text-sm text-muted-foreground">
              {filtered.length} matching · {items.length} loaded
              {next ? " · More available" : ""}
            </p>
          </ResourceToolbar>
          {!filtered.length ? (
            <Empty
              title="No matching providers"
              detail="Try a different provider or endpoint."
            />
          ) : (
            <div
              className="divide-y divide-border border-y border-border"
              role="list"
              aria-label="Model providers"
            >
              {filtered.map((item) => (
                <section
                  role="listitem"
                  key={item.connection_id}
                  className="min-w-0"
                >
                  <button
                    type="button"
                    aria-expanded={expanded === item.connection_id}
                    onClick={() =>
                      setExpanded(
                        expanded === item.connection_id
                          ? undefined
                          : item.connection_id,
                      )
                    }
                    className="flex w-full min-w-0 items-center gap-3 py-4 text-left hover:bg-muted/40 focus-visible:outline-primary"
                  >
                    <Server className="h-5 w-5 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">
                        {item.display_name}
                      </span>
                      <span className="mt-1 block break-all text-xs text-muted-foreground">
                        {item.base_url}
                      </span>
                    </span>
                    <Badge value={item.enabled ? "enabled" : "disabled"} />
                    <ChevronDown
                      className={`h-4 w-4 shrink-0 transition-transform ${expanded === item.connection_id ? "rotate-180" : ""}`}
                    />
                  </button>
                  {expanded === item.connection_id ? (
                    <ProviderDetail
                      key={item.connection_id}
                      connection={item}
                      catalog={
                        catalog.status === "ready" ? catalog.data : undefined
                      }
                      onChange={replace}
                    />
                  ) : null}
                </section>
              ))}
            </div>
          )}
          <ListPagination
            loaded={items.length}
            hasMore={Boolean(next)}
            pending={paging}
            failure={pageFailure}
            onLoadMore={() => void loadMore()}
          />
        </>
      )}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        dismissible={!connecting}
        title="Connect model provider"
      >
        {catalog.status === "ready" ? (
          <ConnectProvider
            onBusy={setConnecting}
            catalog={catalog.data}
            onCancel={() => setOpen(false)}
            onCreated={(value) => {
              setItems((current) =>
                mergePage(current ?? [], [value], (item) => item.connection_id),
              );
              setOpen(false);
              setSuccess(`${value.display_name} connected.`);
              setExpanded(value.connection_id);
            }}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

function ProviderDetail({
  connection,
  catalog,
  onChange,
}: {
  connection: ProviderConnection;
  catalog?: ModelCatalog;
  onChange: (value: ProviderConnection) => void;
}) {
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [availabilityBusy, setAvailabilityBusy] = useState(false);
  const [failure, setFailure] = useState<ResourceFailure>();
  const [success, setSuccess] = useState("");
  const connectionRead = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => connectionRead.current?.abort(), []);
  async function refresh() {
    if (open || availabilityBusy) return;
    connectionRead.current?.abort();
    const controller = new AbortController();
    connectionRead.current = controller;
    setRefreshing(true);
    setFailure(undefined);
    try {
      const current = await api.provider(
        connection.connection_id,
        controller.signal,
      );
      if (current.connection_id !== connection.connection_id)
        throw new Error(
          "The provider response does not match this connection.",
        );
      if (!controller.signal.aborted) onChange(current);
    } catch (cause) {
      if (!controller.signal.aborted) setFailure(resourceFailure(cause));
    } finally {
      if (!controller.signal.aborted) setRefreshing(false);
    }
  }
  return (
    <div className="grid min-w-0 gap-5 pb-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <p className="text-sm text-muted-foreground">
          API key configured · Credential revision{" "}
          {connection.credential_revision}
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={refreshing || Boolean(failure) || availabilityBusy}
            onClick={() => {
              setSuccess("");
              setOpen(true);
            }}
          >
            <KeyRound className="h-4 w-4" />
            Change API key
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Refresh connection"
            title="Refresh connection"
            disabled={refreshing || open || availabilityBusy}
            onClick={() => void refresh()}
          >
            <RefreshCw
              className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
            />
          </Button>
        </div>
      </div>
      {failure ? (
        <ResourceFailureNotice
          failure={failure}
          retryLabel="Retry connection"
          onRetry={() => void refresh()}
        />
      ) : null}
      {success ? (
        <SuccessNotice message={success} onDismiss={() => setSuccess("")} />
      ) : null}
      <CatalogAvailabilityControl
        kind="provider-connections"
        resourceID={connection.connection_id}
        enabled={connection.enabled}
        disabled={open || refreshing || Boolean(failure)}
        onBusyChange={setAvailabilityBusy}
        onReload={async (signal) => {
          const current = await api.provider(connection.connection_id, signal);
          if (current.connection_id !== connection.connection_id)
            throw new Error(
              "The provider response does not match this connection.",
            );
          if (!signal.aborted) onChange(current);
        }}
      />
      <ConnectionModels connection={connection} catalog={catalog} />
      <Dialog
        open={open}
        onOpenChange={setOpen}
        dismissible={!rotating}
        title="Change API key"
      >
        <CredentialEditor
          onBusy={setRotating}
          connection={connection}
          onCancel={() => setOpen(false)}
          onSaved={(value) => {
            onChange(value);
            setOpen(false);
            setSuccess("API key updated.");
          }}
        />
      </Dialog>
    </div>
  );
}

function CredentialEditor({
  connection,
  onCancel,
  onSaved,
  onBusy,
}: {
  onBusy: (busy: boolean) => void;
  connection: ProviderConnection;
  onCancel: () => void;
  onSaved: (value: ProviderConnection) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const submitting = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || conflict) return;
    const key = String(
      new FormData(event.currentTarget).get("api_key") ?? "",
    ).trim();
    if (!key) {
      setError("Enter the new API key.");
      return;
    }
    submitting.current = true;
    setPending(true);
    onBusy(true);
    setError("");
    try {
      onSaved(
        await api.rotateProviderCredential(connection.connection_id, {
          expected_version: connection.credential_version,
          credential: { method: "api_key", api_key: key },
        }),
      );
    } catch (cause) {
      const stale = cause instanceof APIError && cause.status === 409;
      setConflict(stale);
      setError(
        stale
          ? "The credential changed. Cancel and refresh the connection before trying again."
          : errorMessage(cause),
      );
    } finally {
      submitting.current = false;
      setPending(false);
      onBusy(false);
    }
  }
  return (
    <form className="grid gap-5" onSubmit={submit}>
      {error ? <ErrorNotice message={error} /> : null}
      <Field label="New API key">
        <Input
          name="api_key"
          type="password"
          autoComplete="off"
          disabled={pending || conflict}
          required
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={pending || conflict}>
          {pending ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <KeyRound className="h-4 w-4" />
          )}
          Save API key
        </Button>
      </div>
    </form>
  );
}

function ConnectionModels({
  connection,
  catalog,
}: {
  connection: ProviderConnection;
  catalog?: ModelCatalog;
}) {
  const [items, setItems] = useState<ModelProfile[]>();
  const [failure, setFailure] = useState<ResourceFailure>();
  const [next, setNext] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState("");
  const load = useCallback(async (afterID?: string) => {
    setLoading(true);
    setFailure(undefined);
    try {
      const page = await api.models({ afterID });
      setItems((current) =>
        afterID
          ? mergePage(
              current ?? [],
              page.items,
              (item) => item.model_profile_id,
            )
          : page.items,
      );
      setNext(page.next_after_id ?? undefined);
    } catch (cause) {
      setFailure(resourceFailure(cause));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const models =
    items?.filter(
      (item) => item.provider_connection_id === connection.connection_id,
    ) ?? [];
  const provider = catalog?.providers.find(
    (item) => item.provider_key === connection.provider_key,
  );
  function added(model: ModelProfile) {
    setItems((current) =>
      mergePage(current ?? [], [model], (item) => item.model_profile_id),
    );
    setSuccess("Models added.");
  }
  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Models</h2>
        <Button
          size="sm"
          variant="secondary"
          disabled={
            !provider ||
            !connection.enabled ||
            loading ||
            !items ||
            Boolean(failure)
          }
          onClick={() => {
            setSuccess("");
            setOpen(true);
          }}
        >
          <Plus className="h-4 w-4" />
          Add model
        </Button>
      </div>
      {success ? (
        <SuccessNotice message={success} onDismiss={() => setSuccess("")} />
      ) : null}
      {failure ? (
        <ResourceFailureNotice
          failure={failure}
          retryLabel="Retry models"
          onRetry={() => void load(next)}
        />
      ) : null}
      {!items && loading ? <Loading label="Loading models" /> : null}
      {models.map((item) => (
        <a
          key={item.model_profile_id}
          href={`#models/${item.model_profile_id}`}
          className="flex min-w-0 items-center justify-between gap-3 border-b border-border py-3 text-sm hover:text-primary"
        >
          <span className="min-w-0">
            <span className="block break-words font-medium">
              {item.display_name}
            </span>
            <span className="mt-1 block break-all font-mono text-xs text-muted-foreground">
              {item.model.model}
            </span>
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {modelInputLabel(item.model)}
          </span>
        </a>
      ))}
      {items && !models.length && !next && !failure ? (
        <p className="py-3 text-sm text-muted-foreground">No models added.</p>
      ) : null}
      {next ? (
        <ListPagination
          loaded={items?.length ?? 0}
          hasMore
          pending={loading}
          failure={failure}
          onLoadMore={() => void load(next)}
        />
      ) : null}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        dismissible={!pending}
        title="Add model"
      >
        {catalog && provider ? (
          <ProviderModelDiscovery
            connection={connection}
            catalog={catalog}
            onBusy={setPending}
            onClose={() => setOpen(false)}
            onSaved={added}
          />
        ) : null}
      </Dialog>
    </div>
  );
}
