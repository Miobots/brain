import { describe, it, expect } from 'vitest';
import { toModelMessages } from '../../../src/ai/client.ts';
import type { ChatMessage } from '../../../src/ai/types.ts';

/**
 * The agent loop's own tests mock `chat()` wholesale, so nothing ever checked the shape of the
 * messages that would actually be sent. Both of the bugs below were invisible to a green suite:
 * they only appear on the SECOND iteration of a tool-using run, against a real provider.
 *
 * No API key needed — these assert the request we would build, not a response. That the model is
 * given schemas only (no double execution) is covered in tests/unit/brain/agent.test.ts.
 */
describe('ModelMessage shape for a tool-using turn', () => {
  const toolCallId = 'call-1';

  const conversation: ChatMessage[] = [
    { role: 'system', content: 'You are Mio.' },
    { role: 'user', content: 'say salam in urdu' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: toolCallId, name: 'speak', arguments: { text: 'salam', lang: 'ur' } }],
    },
    { role: 'tool', toolCallId, name: 'speak', content: '{"status":"spoken"}' },
  ];

  it('precedes every tool-result with a matching tool-call', async () => {
    const messages = await toModelMessages(conversation, 'anthropic' as never);

    const calls = new Set<string>();
    for (const m of messages) {
      if (!Array.isArray(m.content)) continue;
      for (const part of m.content as Array<Record<string, unknown>>) {
        if (part.type === 'tool-call') {
          calls.add(part.toolCallId as string);
        }
        if (part.type === 'tool-result') {
          // This is the assertion that would have caught the bug: a result whose id was never
          // announced is rejected by Anthropic and OpenAI alike.
          expect(calls.has(part.toolCallId as string)).toBe(true);
        }
      }
    }
  });

  it('carries the tool call on the assistant turn, not just its text', async () => {
    const messages = await toModelMessages(conversation, 'anthropic' as never);
    const assistant = messages.find((m) => m.role === 'assistant');

    expect(assistant).toBeDefined();
    expect(Array.isArray(assistant!.content)).toBe(true);

    const parts = assistant!.content as Array<Record<string, unknown>>;
    const call = parts.find((p) => p.type === 'tool-call');

    expect(call).toBeDefined();
    expect(call!.toolCallId).toBe(toolCallId);
    expect(call!.toolName).toBe('speak');
    expect(call!.input).toEqual({ text: 'salam', lang: 'ur' });
  });

  it('keeps plain assistant turns as plain text', async () => {
    const messages = await toModelMessages(
      [{ role: 'assistant', content: 'Walaikum assalam.' }],
      'anthropic' as never,
    );

    expect(messages[0]!.content).toBe('Walaikum assalam.');
  });
});
