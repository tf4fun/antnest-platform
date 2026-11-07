import assert from "node:assert/strict";

// ACP's wire version is validated by Console and omitted from its browser DTO.
// Normalize only that metadata; retain every audit datum for exact comparison.
export function auditEventsForBrowser(page) {
  const publicFields = (value) => {
    if (Object.hasOwn(value, "schema_version"))
      assert.equal(value.schema_version, 1, "unsupported audit schema_version");
    const fields = { ...value };
    delete fields.schema_version;
    return fields;
  };
  return { ...publicFields(page), items: page.items.map(publicFields) };
}
