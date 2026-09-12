import { describe, expect, it } from "vitest";
import { availableCommands, commandReply, matchCommand } from "../../src/domain/slash-commands.js";
import type { ContentBlock } from "../../src/domain/types.js";

describe("minimal slash command registry", () => {
  it.each(["/help", "  /help\n", "/help details", "/help\tfiles"])(
    "recognizes the exact first token of %j",
    (text) =>
      expect(matchCommand([{ type: "text", text }])).toEqual({ name: "help", locale: "en" }),
  );

  it("recognizes the localized alias without a duplicate menu item", () => {
    const command = matchCommand([{ type: "text", text: "/帮助" }]);
    expect(command).toEqual({ name: "help", locale: "zh" });
    expect(commandReply(command!)[0]?.text).toContain("可用命令");
    expect(availableCommands()).toHaveLength(1);
    expect(availableCommands()[0]?.name).toBe("help");
    expect(availableCommands()[0]?.description).toContain("/帮助");
  });

  it.each([
    "/helpful",
    "/HELP",
    "/help.txt",
    "/workspace/file",
    "/missing",
    "please /help",
    "`/help`",
  ])("keeps %j as normal model input", (text) => {
    expect(matchCommand([{ type: "text", text }])).toBeUndefined();
  });

  it("does not interpret resources or later text as commands and preserves attachments", () => {
    expect(matchCommand([{ type: "text", text: null }])).toBeUndefined();
    expect(
      matchCommand([{ type: "resource", resource: { uri: "file:///note", text: "/help" } }]),
    ).toBeUndefined();
    expect(
      matchCommand([
        { type: "text", text: "ordinary" },
        { type: "text", text: "/help" },
      ]),
    ).toBeUndefined();
    const prompt: ContentBlock[] = [
      { type: "text", text: "  " },
      { type: "text", text: "/help" },
      { type: "resource", resource: { uri: "file:///note", text: "private attachment" } },
    ];
    const before = structuredClone(prompt);
    expect(matchCommand(prompt)).toEqual({ name: "help", locale: "en" });
    expect(prompt).toEqual(before);
  });

  it("advertises only implemented handlers and returns isolated catalog snapshots", () => {
    const advertised = availableCommands();
    for (const command of advertised) {
      const matched = matchCommand([{ type: "text", text: `/${command.name}` }]);
      expect(matched).toBeDefined();
      expect(commandReply(matched!)[0]?.text).toContain(`/${command.name}`);
    }
    advertised[0]!.name = "mutated";
    expect(availableCommands()[0]!.name).toBe("help");
  });
});
