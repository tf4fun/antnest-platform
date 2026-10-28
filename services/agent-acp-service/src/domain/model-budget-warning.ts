import { z } from "zod";

const amount = z.string().regex(/^(0|[1-9][0-9]*)(?![\s\S])/u);
export const budgetWarningFactSchema = z.strictObject({
  scope: z.enum(["organization_daily", "organization_monthly"]),
  periodStart: z.iso.date(),
  limit: amount,
  used: amount,
  unknownCost: z.boolean(),
});
export type BudgetWarningFact = z.infer<typeof budgetWarningFactSchema>;

const noticeSchema = z.strictObject({
  kind: z.literal("agent_message"),
  messageId: z.string().min(1),
  content: z.tuple([z.strictObject({ type: z.literal("text"), text: z.string().min(1) })]),
});
export const budgetWarningNoticesSchema = z.array(noticeSchema).max(2);
export type BudgetWarningNotice = z.infer<typeof noticeSchema>;

export function budgetWarningNotice(
  messageId: string,
  input: BudgetWarningFact,
): BudgetWarningNotice {
  const fact = budgetWarningFactSchema.parse(input);
  return noticeSchema.parse({
    kind: "agent_message",
    messageId,
    content: [
      {
        type: "text",
        text: `Model budget soft threshold reached. Scope: ${fact.scope}; UTC period: ${fact.periodStart}; limit: ${fact.limit}; known charges plus reserved: ${fact.used} USD microdollars. Execution may continue within hard limits.${fact.unknownCost ? " Additional or historical cost remains unknown." : ""}`,
      },
    ],
  });
}
