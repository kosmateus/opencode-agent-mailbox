import { isAbsolute } from 'node:path';
import { z } from 'zod';

export const Options = z
  .object({
    timeoutMs: z.number().int().min(1000).max(86400000).default(300000),
    pollMs: z.number().int().min(100).max(10000).default(250),
    maxPending: z.number().int().min(10).max(10000).default(1000),
    maxMessageLength: z.number().int().min(1).max(16000).default(4000),
    bidirectional: z.boolean().default(false),
    wakeOnReply: z.boolean().default(true),
    dataDirectory: z.string().min(1).refine(isAbsolute, 'Must be an absolute path').optional(),
    toasts: z.boolean().default(false),
  })
  .strict();

export type Options = z.infer<typeof Options>;
