import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { ConfigPicker } from "./ConfigPicker";

export function SessionSettings({
  options,
  disabled,
  onChange,
}: {
  options: SessionConfigOption[];
  disabled: boolean;
  onChange: (id: string, value: string | boolean) => void;
}) {
  if (!options.length) return null;
  const notice = options.find(
    (option) => option.category === "model",
  )?.description;
  return (
    <div
      className="session-settings"
      role="group"
      aria-label="Session settings"
    >
      {notice ? (
        <p className="session-settings-notice" role="status">
          {notice}
        </p>
      ) : null}
      {options.map((option) =>
        option.type === "select" ? (
          <ConfigPicker
            key={option.id}
            option={option}
            disabled={disabled}
            onChange={(value) => onChange(option.id, value)}
          />
        ) : (
          <button key={option.id} type="button" className="config-trigger"
            role="switch" aria-label={option.name}
            aria-checked={option.currentValue} disabled={disabled}
            title={option.description ?? option.name}
            onClick={() => onChange(option.id, !option.currentValue)}>
            <strong>{option.name}</strong>
            <span>{option.currentValue ? "On" : "Off"}</span>
          </button>
        ),
      )}
    </div>
  );
}
