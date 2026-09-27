import { describe, it, expect } from 'vitest';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { toModelMessages, toPrompt } from '../../../src/ai/client.ts';
import type { ChatMessage } from '../../../src/ai/types.ts';

/**
 * B1.4 found this on the first real provider call: AI SDK v7 throws "System messages are not
 * allowed in the prompt or messages fields" before any request leaves the process. The agent
 * loop's tests mock `chat()`, so they never reached the SDK's own validation. These do, through a
 * mock model — no API key needed.
 */
describe('system prompt reaches the model as instructions', () => {
  const conversation: ChatMessage[] = [
    { role: 'system', content: 'You are Mio.' },
    { role: 'user', content: 'say salam in urdu' },
  ];

  function mockModel() {
    return new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'Walaikum assalam.' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      }),
    } as never);
  }

  it('is rejected by the SDK when left inside messages (the bug)', async () => {
    const messages = await toModelMessages(conversation, 'anthropic' as never);
    await expect(generateText({ model: mockModel(), messages })).rejects.toThrow(/System messages/);
  });

  it('is accepted when lifted into instructions, and still sent first', async () => {
    const model = mockModel();
    const result = await generateText({ model, ...(await toPrompt(conversation, 'anthropic' as never)) });

    expect(result.text).toBe('Walaikum assalam.');
    const sent = model.doGenerateCalls[0]!.prompt;
    expect(sent[0]).toMatchObject({ role: 'system', content: 'You are Mio.' });
    expect(sent[1]!.role).toBe('user');
  });

  it('omits instructions entirely when there is no system message', async () => {
    const prompt = await toPrompt([{ role: 'user', content: 'hi' }], 'anthropic' as never);
    expect(prompt).not.toHaveProperty('instructions');
  });
});
