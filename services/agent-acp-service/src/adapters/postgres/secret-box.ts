import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export type SealedValue = {
  ciphertext: Buffer;
  nonce: Buffer;
};

export class SecretBox {
  public constructor(private readonly key: Buffer) {
    if (key.byteLength !== 32) {
      throw new Error("Agent ACP client MCP encryption key must contain exactly 32 bytes");
    }
  }

  public seal(value: unknown, associatedData: string): SealedValue {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(associatedData));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return {
      ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]),
      nonce,
    };
  }

  public open<T>(sealed: SealedValue, associatedData: string): T {
    if (sealed.nonce.byteLength !== NONCE_BYTES || sealed.ciphertext.byteLength < TAG_BYTES) {
      throw new Error("Encrypted client MCP revision is malformed");
    }
    const content = sealed.ciphertext.subarray(0, -TAG_BYTES);
    const tag = sealed.ciphertext.subarray(-TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", this.key, sealed.nonce);
    decipher.setAAD(Buffer.from(associatedData));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(content), decipher.final()]).toString("utf8");
    return JSON.parse(plaintext) as T;
  }
}
