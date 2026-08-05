import { z } from 'zod';

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY missing'),
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY missing'),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1, 'GOOGLE_GENERATIVE_AI_API_KEY missing'),
  AI_FALLBACK_ORDER: z.string().default('reasoning,gpt,gemini'),
  AI_PRIMARY_TIMEOUT_MS: z.coerce.number().default(1200),
});


const parsed = envSchema.safeParse(process.env);
console.log(parsed.error?.flatten().fieldErrors);

if (!parsed.success) {
    throw new Error(
        `Invalid AI config: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`
    );
}

export const aiConfig = {
  ...parsed.data,
  fallbackOrder: parsed.data.AI_FALLBACK_ORDER.split(',') as Array<'reasoning' | 'gpt' | 'gemini'>,
};