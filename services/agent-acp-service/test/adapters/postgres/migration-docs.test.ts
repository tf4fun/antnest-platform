import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrations = new URL("../../../migrations/", import.meta.url);
const document = new URL("../../../docs/architecture.md", import.meta.url);

async function migrationTables(): Promise<string[]> {
  const names = new Set<string>(["schema_migrations"]);
  for (const file of (await readdir(migrations)).filter((name) => name.endsWith(".sql"))) {
    const sql = await readFile(new URL(file, migrations), "utf8");
    for (const match of sql.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-z_]+)/giu))
      names.add(match[1]!);
  }
  return [...names].sort();
}

function documentedTables(markdown: string): string[] {
  const persistence = /## Persistence([\s\S]*?)(?:\n## |$)/u.exec(markdown)?.[1];
  expect(persistence).toBeDefined();
  const rows = persistence!.matchAll(/^\|\s*`([a-z_]+)`\s*((?:\|[^|`]*)+)\|$/gmu);
  return [...rows].map((match) => {
    const cells = match[2]!.split("|").map((cell) => cell.trim());
    expect(cells[0]).toBe("");
    const rules = cells.slice(1);
    expect(rules.length).toBeGreaterThanOrEqual(4);
    expect(rules.every((cell) => cell.length > 0)).toBe(true);
    return match[1]!;
  });
}

async function tableParity() {
  const migrated = await migrationTables();
  const documented = documentedTables(await readFile(fileURLToPath(document), "utf8"));
  return {
    undocumented: migrated.filter((name) => !documented.includes(name)),
    unknown: documented.filter((name) => !migrated.includes(name)),
  };
}

describe("storage documentation parity", () => {
  it("documents every migrated table exactly once in the persistence table", async () => {
    const { undocumented, unknown } = await tableParity();
    expect({ undocumented, unknown }).toEqual({ undocumented: [], unknown: [] });
    const documented = documentedTables(await readFile(fileURLToPath(document), "utf8"));
    expect(documented.length).toBe(new Set(documented).size);
    const migrated = await migrationTables();
    expect(migrated.length).toBe(new Set(migrated).size);
  });

  it("flags a synthetic undocumented table instead of passing silently", async () => {
    const documented = documentedTables(await readFile(fileURLToPath(document), "utf8"));
    const migrated = [...(await migrationTables()), "synthetic_undocumented"];
    const missing = migrated.filter((name) => !documented.includes(name));
    expect(missing).toEqual(["synthetic_undocumented"]);
  });
});
