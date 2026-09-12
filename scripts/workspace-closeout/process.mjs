import assert from "node:assert/strict";

export function processStat(line) {
  const match = line.trim().match(/^(\d+) \(.*\) ([A-Za-z]) (\d+) (\d+) /);
  assert(match, "invalid Linux process stat");
  return { pid: Number(match[1]), state: match[2], group: Number(match[4]) };
}

export function groupAlive(output, group) {
  assert(Number.isSafeInteger(group) && group > 0);
  return output
    .split("\n")
    .filter((line) => line.trim())
    .map(processStat)
    .some((process) => process.group === group && process.state !== "Z");
}

export const readProcesses =
  'for f in /proc/[0-9]*/stat; do if IFS= read -r line < "$f"; then printf \'%s\\n\' "$line"; fi; done';
