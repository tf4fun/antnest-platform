const wav = Buffer.alloc(46);
wav.write("RIFF");
wav.writeUInt32LE(38, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(2, 40);
export const audioData = wav.toString("base64");
export const pdfData = Buffer.from(
  "%PDF-1.4\n% F09_PRIVATE_PDF\n%%EOF\n",
).toString("base64");
export const imageData =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDfkAAAAASUVORK5CYII=";
export const marker = "F09_PRIVATE_EMBEDDED_TEXT";
export function nativePrompt(profile) {
  return [
    { type: "text", text: `${profile} native` },
    { type: "image", mimeType: "image/png", data: imageData },
    { type: "audio", mimeType: "audio/wav", data: audioData },
    {
      type: "resource",
      resource: {
        uri: "attachment:///report.pdf",
        mimeType: "application/pdf",
        blob: pdfData,
      },
    },
    {
      type: "resource",
      resource: {
        uri: "attachment:///notes.txt",
        mimeType: "text/plain",
        text: marker,
      },
    },
    {
      type: "resource",
      resource: {
        uri: "attachment:///blob.txt",
        mimeType: "text/plain",
        blob: Buffer.from(marker).toString("base64"),
      },
    },
    {
      type: "resource_link",
      uri: "http://acp-closeout-model:8080/reference",
      name: "reference",
    },
  ];
}
export function storedPrompt(profile) {
  const prompt = nativePrompt(profile);
  delete prompt[5].resource.blob;
  prompt[5].resource.text = marker;
  return prompt;
}
export function providerContent(profile) {
  return [
    { type: "text", text: `${profile} native` },
    {
      type: "image_url",
      image_url: { url: `data:image/png;base64,${imageData}` },
    },
    { type: "input_audio", input_audio: { data: audioData, format: "wav" } },
    { type: "text", text: "Embedded resource: attachment:///report.pdf" },
    {
      type: "file",
      file: {
        filename: "attachment.pdf",
        file_data: `data:application/pdf;base64,${pdfData}`,
      },
    },
    {
      type: "text",
      text: `Embedded resource: attachment:///notes.txt\n${marker}`,
    },
    {
      type: "text",
      text: `Embedded resource: attachment:///blob.txt\n${marker}`,
    },
    {
      type: "text",
      text: "Resource: reference\nURI: http://acp-closeout-model:8080/reference",
    },
  ];
}
