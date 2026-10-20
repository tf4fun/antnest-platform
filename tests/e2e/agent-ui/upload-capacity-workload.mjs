import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { cacheRuntimeFiles } from "../workspace-closeout/cache-runtime-work.mjs";

export const capacityContextWindow = 8 * 1024 * 1024;

export const capacityCases = Object.freeze(
  ["receive", "parse"].flatMap((phase) =>
    ["cancel", "stop"].map((control) => ({
      id: "capacity-" + phase + "-" + control,
      phase:
        phase === "receive" ? "body-incomplete" : "body-completion-and-parse",
      cancel_path: control === "cancel" ? "operation-cancel" : "commands-stop",
    })),
  ),
);
const crcTable = Array.from({ length: 256 }, (_, i) => {
  let v = i;
  for (let n = 0; n < 8; n++) v = (v >>> 1) ^ (v & 1 ? 0xedb88320 : 0);
  return v >>> 0;
});
function chunk(name, data) {
  const type = Buffer.from(name),
    payload = Buffer.concat([type, data]);
  let crc = 0xffffffff;
  for (const value of payload)
    crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8);
  const head = Buffer.alloc(4),
    tail = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([head, payload, tail]);
}
let images;
export function capacityImages() {
  if (images) return images;
  images = Array.from({ length: 3 }, (_, index) => {
    const width = 1024,
      height = 1020,
      stride = width * 4 + 1;
    const raw = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const at = y * stride + 1 + x * 4;
        raw[at] = (x + index * 47) & 255;
        raw[at + 1] = (y + index * 71) & 255;
        raw[at + 2] = (x + y) & 255;
        raw[at + 3] = 255;
      }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;
    // Valid uncompressed DEFLATE is intentional: actual PNG pixel bytes occupy
    // the advertised attachment budget without padding or malformed media.
    const bytes = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(raw, { level: 0 })),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    assert(bytes.length <= 4 * 1024 * 1024);
    return {
      bytes,
      width,
      height,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  return images;
}
export function capacityDecision(payload) {
  assert.equal(payload.model, "stage3-model");
  const index = payload.messages.findLastIndex((m) => m.role === "user"),
    content = payload.messages[index]?.content;
  const phase = Array.isArray(content) ? content[0]?.text : content;
  assert(
    capacityCases.some(
      (c) => phase === c.id + "-held" || phase === c.id + "-upload",
    ),
    "unexpected capacity phase",
  );
  assert.equal(
    payload.messages.length,
    index + 1,
    "held work must not continue naturally",
  );
  if (phase.endsWith("-held")) {
    assert(payload.tools.some((t) => t.function.name === "bash"));
    return {
      phase,
      call: {
        name: "bash",
        arguments: {
          working_dir: ".",
          timeout_ms: 120000,
          command: [
            "set -eu",
            ...Object.values(cacheRuntimeFiles).map(
              (path) => "test ! -e " + path,
            ),
            "printf 'started\\n' > " + cacheRuntimeFiles.effects,
            "printf '%s' \"$$\" > " + cacheRuntimeFiles.started,
            "while :; do sleep 0.1; done",
          ].join("\n"),
        },
      },
    };
  }
  assert(Array.isArray(content) && content.length === 4);
  const expected = capacityImages(),
    received = content.slice(1).map((image, i) => {
      assert.equal(image.type, "image_url");
      const prefix = "data:image/png;base64,";
      assert(image.image_url.url.startsWith(prefix));
      const encoded = image.image_url.url.slice(prefix.length),
        bytes = Buffer.from(encoded, "base64");
      assert.equal(bytes.toString("base64"), encoded);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      assert.equal(sha256, expected[i].sha256);
      return { sha256, size: bytes.length };
    });
  return {
    phase,
    text: phase + " completed; three original PNGs accepted.",
    report: { images: received },
  };
}
