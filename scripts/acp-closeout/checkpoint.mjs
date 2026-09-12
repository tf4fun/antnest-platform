import { writeFile, rename } from "node:fs/promises";

export async function publishCheckpoint(
  path,
  value,
  files = { writeFile, rename },
) {
  const pending = `${path}.pending`;
  await files.writeFile(pending, JSON.stringify(value), { flag: "wx" });
  await files.rename(pending, path);
}
