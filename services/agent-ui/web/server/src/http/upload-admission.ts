import { HttpInputError } from "./json-request.ts";

export const maximumJsonRequestBytes = 64 * 1024 * 1024;
export const maximumControlRequestBytes = 16 * 1024;

// Owner and SSE limits do not cover bodies waiting for EOF or dispatch. Reserve
// wire bytes before consuming a prompt and hold them until that dispatch settles.
export class UploadAdmission {
  private bytes = 0;
  private count = 0;
  private readonly principals = new Map<string, { bytes: number; count: number }>();

  public acquire(organization: string, user: string, contentLength: string | undefined): () => void {
    const bytes = contentLength === undefined ? maximumJsonRequestBytes : Number(contentLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maximumJsonRequestBytes)
      throw new HttpInputError(413, "request_too_large");
    const key = JSON.stringify([organization, user]);
    const principal = this.principals.get(key) ?? { bytes: 0, count: 0 };
    if (this.bytes + bytes > 128 * 1024 * 1024 || this.count >= 16 ||
      principal.bytes + bytes > maximumJsonRequestBytes || principal.count >= 4)
      throw new HttpInputError(429, "upload_capacity_exceeded");
    this.bytes += bytes;
    this.count++;
    principal.bytes += bytes;
    principal.count++;
    this.principals.set(key, principal);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.bytes -= bytes;
      this.count--;
      principal.bytes -= bytes;
      principal.count--;
      if (principal.count === 0) this.principals.delete(key);
    };
  }
}
