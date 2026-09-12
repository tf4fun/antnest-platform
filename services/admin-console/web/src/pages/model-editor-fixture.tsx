import { useState } from "react";
import { Dialog } from "../components/ui/dialog";
import { api } from "../lib/api";
import type { ModelCatalog } from "../lib/types";
import { ModelEditor } from "./model-editor";

// Form boundary fixture: connection selection is tested through ProvidersPage.
export function ModelEditorFixture({ catalog }: { catalog: ModelCatalog }) {
  const [open, setOpen] = useState(true);
  const [pending, setPending] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      dismissible={!pending}
      title="Add model"
    >
      <ModelEditor
        catalog={catalog}
        provider={catalog.providers[0]}
        pending={pending}
        submitLabel="Add model"
        onCancel={() => setOpen(false)}
        onSubmit={async (value) => {
          setPending(true);
          try {
            await api.createModel({
              ...value,
              provider_connection_id: "connection-1",
            });
            setOpen(false);
          } finally {
            setPending(false);
          }
        }}
      />
    </Dialog>
  );
}
