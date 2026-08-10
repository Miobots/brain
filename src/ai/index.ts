export type {
  Capability,
  Attachment,
  ChatMessage,
  ToolDefinition,
  ToolCall,
  ToolChoice,
  ChatRequest,
  ChatSuccess,
  ChatFailure,
  ChatResult,
  StreamHandle,
  OutputFile,
  TokenUsage,
  FinishReason,
  AiErrorCode,
} from './types.js';

export { chat, stream } from './client.js';
export { builtinTools } from './tools/index.js';