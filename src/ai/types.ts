export type Capability = 'reasoning' | 'fast' | 'cheap' | 'vision' | (string & {});
 

export interface Attachment {
  source: { path: string } | { data: Uint8Array; filename?: string } | { url: string };
  mediaType?: string;
}
 
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  attachments?: Attachment[];
  toolCallId?: string; // required when role === 'tool'
  name?: string;
}
 
export type JsonSchema = Record<string, unknown>;
 
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute?: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}
 
export type ToolChoice = 'auto' | 'required' | 'none' | { name: string };
 
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown; //present if tool had execute and sdk ran it
}
 
export interface ChatRequest {
  correlationId: string;
  sessionId?: string;
  userId?: string;
 
  capability: Capability;
  messages: ChatMessage[];
 
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
 
  temperature?: number;
  maxOutputTokens?: number;
  responseFormat?: 'text' | 'json';
  metadata?: Record<string, unknown>;
}
 
export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error' | 'unknown';
 

export interface OutputFile {
  mediaType: string;
  data: Uint8Array;
}
 
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
 
export interface ChatSuccess {
  ok: true;
  correlationId: string;
  text?: string;
  toolCalls?: ToolCall[];
  files: OutputFile[];
  finishReason: FinishReason;
  provider: string;
  model: string;
  capability: Capability;
  usage: TokenUsage;
  latencyMs: number;
}
 
export type AiErrorCode =
  | 'timeout'
  | 'auth'
  | 'rate_limited'
  | 'invalid_model'
  | 'invalid_request'
  | 'provider_unreachable'
  | 'not_configured'
  | 'unknown';
 
export interface ChatFailure {
  ok: false;
  correlationId: string;
  capability: Capability;
  error: { code: AiErrorCode; message: string; provider?: string; model?: string };
}
 
export type ChatResult = ChatSuccess | ChatFailure;
 
export interface StreamHandle {
  textStream: AsyncIterable<string>;
  final: Promise<ChatResult>;
}

export interface AiClient {
  chat(req: ChatRequest): Promise<ChatResult>;
  stream(req: ChatRequest): Promise<StreamHandle>;
}