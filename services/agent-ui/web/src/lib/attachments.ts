import type { PromptCapabilities } from "@agentclientprotocol/sdk";

type Capabilities = PromptCapabilities | null | undefined;
export type FileDescription = { kind: "image" | "audio" | "pdf" | "text"; mimeType: string };
const MIB = 1_048_576;
const imageTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const audioTypes = ["audio/wav", "audio/x-wav", "audio/wave", "audio/mpeg", "audio/mp3"];
const textExtensions = "c,cc,cpp,css,csv,go,h,html,java,js,json,jsx,md,py,rb,rs,sh,sql,toml,ts,tsx,txt,xml,yaml,yml".split(",");
const extensionTypes: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  wav: "audio/wav", mp3: "audio/mpeg", pdf: "application/pdf",
};

export function attachmentAccept(capabilities: Capabilities): string {
  return [
    ...textExtensions.map(extension => `.${extension}`),
    ...(capabilities?.image ? imageTypes : []),
    ...(capabilities?.audio ? [".wav", ".mp3", ...audioTypes] : []),
    ...(capabilities?.embeddedContext ? [".pdf", "application/pdf"] : []),
  ].join(",");
}

export function validateAttachmentCount(count: number): void {
  if (count > 6) throw new Error("Attach up to six files per message.");
}

export function describeAttachment(file: File, capabilities: Capabilities): FileDescription {
  const description = classifyFile(file);
  const required = { image: "image", audio: "audio", pdf: "embeddedContext", text: undefined } as const;
  const capability = required[description.kind];
  if (capability && !capabilities?.[capability]) {
    throw new Error(`This Agent does not accept ${description.kind === "pdf" ? "PDF" : description.kind} prompts.`);
  }
  const maxMiB = description.kind === "image" || (description.kind === "text" && !capabilities?.embeddedContext) ? 4 : 1;
  if (file.size > maxMiB * MIB) throw new Error(`${file.name} exceeds the ${maxMiB} MiB attachment limit.`);
  if (description.kind === "audio" && file.size === 0) throw new Error("Audio files must not be empty.");
  return description;
}

function classifyFile(file: File): FileDescription {
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  let mimeType = file.type.toLowerCase().trim();
  if (mimeType === "" || mimeType === "application/octet-stream") {
    mimeType = extensionTypes[extension] ?? (textExtensions.includes(extension) ? "text/plain" : mimeType);
  }
  if (imageTypes.includes(mimeType)) return { kind: "image", mimeType };
  if (audioTypes.includes(mimeType)) return { kind: "audio", mimeType };
  if (mimeType === "application/pdf") return { kind: "pdf", mimeType };
  const [baseType, ...parameters] = mimeType.split(";").map(part => part.trim());
  const validEncoding = parameters.every(part => !part.startsWith("charset=") || ["charset=utf-8", "charset=us-ascii"].includes(part));
  if (validEncoding && (baseType.startsWith("text/") ||
    ["application/json", "application/javascript", "application/xml", "application/yaml", "application/toml"].includes(baseType) ||
    baseType.endsWith("+json") || baseType.endsWith("+xml"))) return { kind: "text", mimeType };
  throw new Error(`${file.name}: this file format is not supported. Use UTF-8 text, images, WAV/MP3 or PDF.`);
}

export function inlineMediaURL(kind: "image" | "audio", mimeType: string, data: unknown): string | undefined {
  const allowed = kind === "image" ? imageTypes : audioTypes;
  const maxBytes = kind === "image" ? 4 * MIB : MIB;
  if (!allowed.includes(mimeType) || typeof data !== "string" || data.length === 0 ||
    data.length > 4 * Math.ceil(maxBytes / 3) || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return undefined;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  if (data.length * 3 / 4 - padding > maxBytes) return undefined;
  return `data:${mimeType};base64,${data}`;
}
