import { z } from "zod";

export const runtimeConnectionIdSchema = z.string().regex(/^rci_[0-9a-f]{32}$/u);
export const runtimeRevisionSchema = z.string().regex(/^rtv_[0-9a-f]{32}$/u);

export const runtimeTokenSchema = z
  .string()
  .min(43)
  .max(86)
  .regex(/^[A-Za-z0-9_-]+$/u)
  .refine((value) => {
    const bytes = Buffer.from(value, "base64url");
    return bytes.length >= 32 && bytes.length <= 64 && bytes.toString("base64url") === value;
  }, "Expected a canonical instance credential");

export const runtimeMcpEndpointSchema = z
  .string()
  .max(1024)
  .refine((value) => {
    if (
      !/^https?:\/\/(?:[A-Za-z0-9][A-Za-z0-9_.-]*|\[[0-9a-fA-F:]+\])(?::[0-9]{1,5})?\/mcp$/u.test(
        value,
      )
    )
      return false;
    try {
      const url = new URL(value);
      return url.href === value && (url.port === "" || Number(url.port) > 0);
    } catch {
      return false;
    }
  }, "Expected a canonical Runtime MCP endpoint");
