import { describe, expect, it } from "vitest";
import { inspectDiscoveryPackage } from "../../src/domain/skill-discovery-package.js";
import { learningSkillTextPackage } from "../../src/domain/learning-candidate-package.js";
import { packageWithFiles, packageWithFilesDigest } from "../fixtures/skill-discovery-package.js";

const text = '---\nname: "test-skill"\ndescription: "A procedure"\n---\nSteps.\n';
describe("bounded discovery package inspection", () => {
  it("shares the existing canonical single-file manifest identity", async () => {
    const pkg = learningSkillTextPackage(text);
    expect(await inspectDiscoveryPackage(pkg.artifact)).toEqual({
      skillText: text,
      contentDigest: pkg.targetDigest,
      requiresRuntimeDelivery: false,
    });
  });
  it("reads a standard deflated ZIP and includes executable asset flags in its digest", async () => {
    const value = await inspectDiscoveryPackage(packageWithFiles);
    expect(value.skillText).toContain("Use the steps.");
    expect(value.requiresRuntimeDelivery).toBe(true);
    expect(value.contentDigest).toBe(packageWithFilesDigest);
    const changed = Buffer.from(packageWithFiles);
    let offset = changed.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    offset = changed.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), offset + 1);
    changed.writeUInt32LE(0o100644 * 65536, offset + 38);
    expect((await inspectDiscoveryPackage(changed)).contentDigest).not.toBe(value.contentDigest);
  });
  it("rejects truncation and actual CRC/size failures", async () => {
    const pkg = learningSkillTextPackage(text);
    await expect(inspectDiscoveryPackage(pkg.artifact.subarray(0, -1))).rejects.toThrow();
    const changed = Buffer.from(pkg.artifact);
    changed[40] = changed[40]! ^ 1;
    await expect(inspectDiscoveryPackage(changed)).rejects.toThrow();
  });
  it("rejects declared oversized text before inflation", async () => {
    const pkg = learningSkillTextPackage(text);
    const changed = Buffer.from(pkg.artifact);
    const central = changed.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    changed.writeUInt32LE(16_385, central + 24);
    await expect(inspectDiscoveryPackage(changed)).rejects.toThrow();
  });
  it("rejects symbolic-link entries", async () => {
    const changed = Buffer.from(packageWithFiles);
    const central = changed.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    changed[central + 5] = 3;
    changed.writeUInt32LE(0o120777 * 65536, central + 38);
    await expect(inspectDiscoveryPackage(changed)).rejects.toThrow();
  });
});
