export function parseCapacityResponse(bytes, privateValues) {
  const text = bytes.toString("utf8");
  const safe = (value) => {
    for (const secret of privateValues)
      if (secret && value.includes(secret))
        throw new Error("Capacity response contains private test credentials");
  };
  safe(text);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Capacity response JSON is invalid");
  }
  // JSON escapes must not hide private values until a later field assertion.
  const pending = [parsed];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string") safe(value);
    else if (value !== null && typeof value === "object")
      for (const [key, item] of Object.entries(value)) {
        safe(key);
        pending.push(item);
      }
  }
  return parsed;
}
