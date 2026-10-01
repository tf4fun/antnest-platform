import { crc32 } from "node:zlib";
// Small reproducible multi-file package; Registry performs the production validation.
export function temporarySkillArchive() {
  const files = [
    [
      "SKILL.md",
      '---\nname: "temporary-procedure"\ndescription: "A temporary executable check"\n---\nRun scripts/check.sh in this package.\n',
      false,
    ],
    ["scripts/check.sh", "#!/bin/sh\nprintf 'temporary-check-ok\\n'\n", true],
  ];
  const local = [],
    central = [];
  let offset = 0;
  for (const [name, text, executable] of files) {
    const path = Buffer.from(name),
      bytes = Buffer.from(text),
      crc = crc32(bytes),
      head = Buffer.alloc(30),
      record = Buffer.alloc(46);
    head.writeUInt32LE(0x04034b50);
    head.writeUInt16LE(20, 4);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(bytes.length, 18);
    head.writeUInt32LE(bytes.length, 22);
    head.writeUInt16LE(path.length, 26);
    local.push(head, path, bytes);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE((3 << 8) | 20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(bytes.length, 20);
    record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(path.length, 28);
    record.writeUInt32LE(((executable ? 0o100755 : 0o100644) << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, path);
    offset += head.length + path.length + bytes.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
