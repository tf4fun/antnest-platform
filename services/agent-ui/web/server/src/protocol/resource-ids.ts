import { z } from "zod";

const opaque = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}(?![\s\S])/u;
export const agentIdSchema = z.string().min(1).max(200).regex(opaque);
export const organizationIdSchema = z.string().min(1).max(200).regex(opaque);
export const userIdSchema = z.string().min(1).max(200).regex(opaque);
