import { useState } from "react";
import { runtimeImageLabel } from "../lib/runtime-image";
import { Field, Input, Select } from "./ui/input";

export function RuntimeImageChoice({ image, source, inheritedLabel }: {
  image: string;
  source?: string;
  inheritedLabel: string;
}) {
  const [custom, setCustom] = useState(false);
  const selected = custom || !image;
  return (
    <div className="grid gap-3">
      <Field label="Runtime image">
        <Select name="image_mode" value={selected ? "custom" : "inherited"} onChange={(event) => setCustom(event.target.value === "custom")}>
          {image ? <option value="inherited">{inheritedLabel}</option> : null}
          <option value="custom">Choose image tag</option>
        </Select>
      </Field>
      {selected ? (
        <Field label="Image tag">
          <Input name="image_ref" defaultValue={source ?? ""} placeholder="antnest/antnest-runtime:local" maxLength={512} required />
        </Field>
      ) : <p className="break-all text-sm text-muted-foreground">{runtimeImageLabel(image, source)}</p>}
    </div>
  );
}
