import type { ToolDefinition } from '../types.js';

export const consoleLogTool: ToolDefinition = {
  name: 'console_log',
  description: 'Log a message to the console. Useful for debugging or noting something out loud.',
  parameters: {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
  },
  execute: (args) => {
    console.log('[console_log tool]', args.message);
    return { logged: true };
  },
};