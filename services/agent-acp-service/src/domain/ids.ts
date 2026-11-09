import { z } from "zod";

export const scopedIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}(?![\s\S])/u;

export const organizationIdSchema = z.string().min(1).max(200).regex(scopedIdPattern);
export const userIdSchema = z.string().min(1).max(200).regex(scopedIdPattern);
export const agentIdSchema = z.string().min(1).max(200).regex(scopedIdPattern);
