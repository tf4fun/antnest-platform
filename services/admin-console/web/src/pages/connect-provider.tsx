import { useState, type FormEvent } from "react";
import { ListFilter } from "lucide-react";
import { Button } from "../components/ui/button";
import { Field, Input, Select } from "../components/ui/input";
import { api } from "../lib/api";
import type {
  ModelCatalog,
  ProviderConnection,
  ProviderDiscoveryDraft,
} from "../lib/types";
import { ProviderModelDiscovery } from "./provider-model-discovery";

export function ConnectProvider({
  catalog,
  onCancel,
  onCreated,
  onBusy,
}: {
  catalog: ModelCatalog;
  onCancel: () => void;
  onCreated: (connection: ProviderConnection) => void;
  onBusy: (busy: boolean) => void;
}) {
  const providers = catalog.providers.filter((item) => !item.custom);
  const [key, setKey] = useState(providers[0]?.provider_key ?? "");
  const provider = providers.find((item) => item.provider_key === key);
  const [endpoint, setEndpoint] = useState(provider?.base_url ?? "");
  const [apiKey, setAPIKey] = useState("");
  const [draft, setDraft] = useState<ProviderDiscoveryDraft>();
  function discover(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!provider || !apiKey.trim()) return;
    setDraft({
      provider_key: key,
      base_url: endpoint.trim(),
      credential: { method: "api_key", api_key: apiKey.trim() },
    });
  }
  if (draft && provider)
    return (
      <ProviderModelDiscovery
        connection={{
          connection_id: "",
          provider_key: key,
          display_name: provider.display_name,
          base_url: draft.base_url,
        }}
        draft={draft}
        catalog={catalog}
        onBusy={onBusy}
        onClose={() => setDraft(undefined)}
        onConnect={async (models) =>
          onCreated(
            await api.createProvider({
              ...draft,
              display_name: provider.display_name,
              models,
            }),
          )
        }
      />
    );
  return (
    <form className="grid gap-5" onSubmit={discover}>
      <Field label="Provider">
        <Select
          value={key}
          onChange={(event) => {
            const next = providers.find(
              (item) => item.provider_key === event.target.value,
            );
            setKey(event.target.value);
            setEndpoint(next?.base_url ?? "");
            setAPIKey("");
          }}
        >
          {providers.map((item) => (
            <option key={item.provider_key} value={item.provider_key}>
              {item.display_name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="API key">
        <Input
          name="api_key"
          type="password"
          autoComplete="off"
          required
          value={apiKey}
          onChange={(event) => setAPIKey(event.target.value)}
        />
      </Field>
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          Connection settings
        </summary>
        <div className="mt-3">
          <Field label="API endpoint">
            <Input
              type="url"
              required
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
            />
          </Field>
        </div>
      </details>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!provider || !apiKey.trim()}>
          <ListFilter className="h-4 w-4" />
          Select models
        </Button>
      </div>
    </form>
  );
}
