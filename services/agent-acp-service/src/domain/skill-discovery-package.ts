import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { addAbortListener } from "node:events";
import { crc32 } from "node:zlib";
import { fromBufferPromise, type Entry, type ZipFile } from "yauzl";
import { SkillDiscoveryError } from "./skill-discovery.js";

type FileDigest = { path: Buffer; size: number; digest: Buffer; executable: boolean };

/** Inspect verified Registry bytes without extracting files or retaining assets.
 * YAML/package publication validation belongs to Registry; this consumer checks
 * transport identity, bounded actual bytes and the complete manifest. */
export async function inspectDiscoveryPackage(artifact: Buffer, signal?: AbortSignal) {
  let zip: ZipFile | undefined;
  try {
    signal?.throwIfAborted();
    if (artifact.length === 0 || artifact.length > 8 * 1024 * 1024) throw invalid();
    zip = await fromBufferPromise(artifact, { strictFileNames: true, validateEntrySizes: true });
    if (zip.entryCount === 0 || zip.entryCount > 256) throw invalid();
    const files: FileDigest[] = [];
    const seen = new Map<string, boolean>();
    let skillText: string | undefined;
    let total = 0;
    for await (const entry of zip.eachEntry()) {
      signal?.throwIfAborted();
      const name = entry.fileName;
      const directory = name.endsWith("/");
      const path = directory ? name.slice(0, -1) : name;
      const parts = path.split("/");
      const mode = entry.externalFileAttributes >>> 16;
      const unix = [3, 19].includes(entry.versionMadeBy >>> 8);
      const type = unix ? mode & 0o170000 : 0;
      if (
        !isUtf8(entry.fileNameRaw) ||
        entry.fileNameRaw.toString("utf8") !== name ||
        Buffer.byteLength(path) > 512 ||
        parts.length > 16 ||
        /[\\\0]/u.test(path) ||
        parts.some((part) => !part || part === "." || part === "..") ||
        seen.has(path) ||
        entry.isEncrypted() ||
        entry.extraFields.some((field) => field.id !== 0x0001 && field.id !== 0x5455) ||
        (type !== 0 && type !== (directory ? 0o040000 : 0o100000))
      )
        throw invalid();
      seen.set(path, directory);
      if (directory) {
        if (entry.uncompressedSize !== 0) throw invalid();
        continue;
      }
      const max = path === "SKILL.md" ? 16 * 1024 : 8 * 1024 * 1024;
      if (entry.uncompressedSize > max || total + entry.uncompressedSize > 32 * 1024 * 1024)
        throw invalid();
      const file = await inspectFile(zip, entry, max, path === "SKILL.md", signal);
      total += file.size;
      files.push({
        path: Buffer.from(path, "utf8"),
        size: file.size,
        digest: file.digest,
        executable: unix && (mode & 0o111) !== 0,
      });
      if (file.body !== undefined) {
        if (!isUtf8(file.body) || file.body.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])))
          throw invalid();
        skillText = file.body.toString("utf8");
      }
    }
    for (const path of seen.keys()) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i += 1)
        if (seen.get(parts.slice(0, i).join("/")) === false) throw invalid();
    }
    if (skillText === undefined) throw invalid();
    const hash = createHash("sha256").update("antnest-skill-manifest-v1\0");
    for (const file of files.sort((a, b) => Buffer.compare(a.path, b.path))) {
      const frame = Buffer.alloc(4 + file.path.length + 8 + 32 + 1);
      frame.writeUInt32BE(file.path.length);
      file.path.copy(frame, 4);
      frame.writeBigUInt64BE(BigInt(file.size), 4 + file.path.length);
      file.digest.copy(frame, 4 + file.path.length + 8);
      frame[frame.length - 1] = file.executable ? 1 : 0;
      hash.update(frame);
    }
    signal?.throwIfAborted();
    return {
      skillText,
      contentDigest: `sha256:${hash.digest("hex")}`,
      requiresRuntimeDelivery: files.length > 1,
    };
  } catch {
    signal?.throwIfAborted();
    throw invalid();
  } finally {
    zip?.close();
  }
}

async function inspectFile(
  zip: ZipFile,
  entry: Entry,
  max: number,
  keepBody: boolean,
  signal?: AbortSignal,
) {
  const stream = await zip.openReadStreamPromise(entry);
  const abort =
    signal === undefined
      ? undefined
      : addAbortListener(signal, () => {
          stream.destroy(new Error("Skill package read cancelled"));
        });
  let size = 0,
    crc = 0;
  const hash = createHash("sha256"),
    chunks: Buffer[] = [];
  try {
    for await (const value of stream) {
      signal?.throwIfAborted();
      if (!Buffer.isBuffer(value)) throw invalid();
      size += value.length;
      if (size > max) throw invalid();
      crc = crc32(value, crc);
      hash.update(value);
      if (keepBody) chunks.push(value);
    }
    if (size !== entry.uncompressedSize || crc !== entry.crc32) throw invalid();
    return { size, digest: hash.digest(), ...(keepBody ? { body: Buffer.concat(chunks) } : {}) };
  } finally {
    abort?.[Symbol.dispose]();
    stream.destroy();
  }
}
function invalid() {
  return new SkillDiscoveryError("source_invalid");
}
