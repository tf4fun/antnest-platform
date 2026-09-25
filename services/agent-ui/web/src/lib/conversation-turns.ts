import type { Message } from "./types.ts";

export type ConversationTurn = {
  id: string;
  prompt?: Message;
  response: Message[];
  process: Message[];
  output?: Message;
  notices: Message[];
};

export function conversationTurns(
  messages: readonly Message[],
): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const message of messages) {
    if (!turns.length || message.role === "user") {
      turns.push({ id: message.id, response: [], process: [], notices: [] });
    }
    const turn = turns[turns.length - 1];
    if (message.role === "user") turn.prompt = message;
    else {
      turn.response.push(message);
      if (message.role === "system") turn.notices.push(message);
    }
  }
  for (const turn of turns) {
    turn.output = latestAnswer(turn.response);
    turn.process = turn.response.filter(
      (message) => message.role === "assistant" && message !== turn.output,
    );
  }
  return turns;
}

function latestAnswer(response: readonly Message[]): Message | undefined {
  for (let index = response.length - 1; index >= 0; index--) {
    const message = response[index];
    if (message.role !== "assistant") continue;
    // A subsequent tool means the preceding text was an intermediate response.
    if (message.activities?.length) return undefined;
    if (
      !message.presentation &&
      (message.content.trim() || message.attachments?.length || message.contentIncomplete)
    )
      return message;
  }
  return undefined;
}
