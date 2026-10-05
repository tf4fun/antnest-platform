// JSON.parse alone silently accepts duplicate members. Scan the same grammar
// first, comparing decoded keys at every depth, then use the native parser.
export function strictJson(raw: Uint8Array | string): unknown {
  const text =
    typeof raw === "string"
      ? raw
      : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  let position = 0;
  const whitespace = () => {
    while (/[\t\n\r ]/u.test(text[position] ?? "x")) position++;
  };
  const string = (): string => {
    const start = position++;
    while (position < text.length) {
      const character = text[position++];
      if (character === "\\") {
        position++;
        continue;
      }
      if (character === '"') return JSON.parse(text.slice(start, position)) as string;
    }
    throw new Error("invalid_json");
  };
  const value = (depth: number): void => {
    if (depth > 64) throw new Error("invalid_json");
    whitespace();
    const character = text[position];
    if (character === '"') {
      string();
      return;
    }
    if (character === "{" || character === "[") {
      position++;
      const end = character === "{" ? "}" : "]";
      const keys = new Set<string>();
      whitespace();
      if (text[position] === end) {
        position++;
        return;
      }
      for (;;) {
        if (character === "{") {
          whitespace();
          if (text[position] !== '"') throw new Error("invalid_json");
          const key = string();
          if (keys.has(key)) throw new Error("invalid_json");
          keys.add(key);
          whitespace();
          if (text[position++] !== ":") throw new Error("invalid_json");
        }
        value(depth + 1);
        whitespace();
        const next = text[position++];
        if (next === end) return;
        if (next !== ",") throw new Error("invalid_json");
      }
    }
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(
      text.slice(position),
    );
    if (!literal) throw new Error("invalid_json");
    position += literal[0].length;
  };
  value(0);
  whitespace();
  if (position !== text.length) throw new Error("invalid_json");
  return JSON.parse(text) as unknown;
}

export function strictObject(raw: Uint8Array | string): Record<string, unknown> {
  const value = strictJson(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_json");
  return value as Record<string, unknown>;
}
