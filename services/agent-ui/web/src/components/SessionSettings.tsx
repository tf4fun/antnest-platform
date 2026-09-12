import type { SessionConfigOption } from "@agentclientprotocol/sdk";

export function SessionSettings({ options, disabled, onChange }: {
  options: SessionConfigOption[];
  disabled: boolean;
  onChange: (id: string, value: string) => void;
}) {
  return <div className="session-settings">{options.map((option) => {
    if (option.type !== "select") return null;
    return <label key={option.id}><span>{option.name}</span>
      <select aria-label={option.name} value={option.currentValue} disabled={disabled}
        onChange={(event) => onChange(option.id, event.target.value)}>
        {option.options.map((item) => "options" in item
          ? <optgroup key={item.group} label={item.name}>{item.options.map((choice) =>
            <option key={choice.value} value={choice.value}>{choice.name}</option>)}</optgroup>
          : <option key={item.value} value={item.value}>{item.name}</option>)}
      </select>
    </label>;
  })}</div>;
}
