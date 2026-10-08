// Docker's log copier splits container output lines longer than 16 KiB, and
// the json-file driver replaces each half of a multi-byte character cut by
// such a split with U+FFFD. Results read back through `docker logs` are
// therefore printed as ASCII-only JSON: the \u escapes parse back to the same
// value, and no split can fall inside a character.
export function asciiJSON(value) {
  // Without the u flag the class matches UTF-16 code units, so a character
  // outside the BMP becomes its escaped surrogate pair.
  return JSON.stringify(value)?.replace(
    /[\u007f-\uffff]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
