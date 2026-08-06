

export type Capability =
  | 'reasoning'
  | 'fast'
  | 'cheap'
  | 'vision'
  | (string & {});



export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: Uint8Array | string; mimeType?: string };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  toolCallId?: string;
  name?: string;
}

export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ToolChoice =
  | 'auto'
  | 'required'
  | 'none'
  | { type: 'tool'; name: string };



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

  stream?: boolean;

  metadata?: Record<string, unknown>;
}

export type FinishReason =
  | 'stop'
  | 'tool_calls'
  | 'length'
  | 'content_filter'
  | 'error'
  | 'unknown';

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
  finishReason: FinishReason;
 
  provider: string;
  model: string;
  capability: Capability;
  usage: TokenUsage;
  latencyMs: number;
}

export interface AiErrorDetail {
  code: AiErrorCode;
  message: string;
  provider?: string;
  model?: string;
  retryable?: boolean;
  cause?: unknown;
}

export interface ChatFailure {
  ok: false;
  correlationId: string;
  capability: Capability;
  error: AiErrorDetail;
}

export type ChatResult = ChatSuccess | ChatFailure;



export type AudioFormat = 'mp3' | 'wav' | 'pcm16';

export interface SpeechRequest {
  correlationId: string;
  text: string;

  voice?: string;
  format?: AudioFormat;

  language?: string;
  speed?: number;
  metadata?: Record<string, unknown>;
}

export interface SpeechSuccess {
  ok: true;
  correlationId: string;
  audio: Uint8Array;
  format: AudioFormat;
  provider: string;
  model: string;
  latencyMs: number;
}

export interface SpeechFailure {
  ok: false;
  correlationId: string;
  error: AiErrorDetail;
}

export type SpeechResult = SpeechSuccess | SpeechFailure;


export type AiErrorCode =
  | 'timeout'
  | 'auth'
  | 'rate_limited'
  | 'invalid_model'
  | 'invalid_request'
  | 'provider_unreachable'
  | 'not_configured'
  | 'not_implemented'
  | 'content_filtered'
  | 'unknown';



export interface AiInterface {
  chat(req: ChatRequest): Promise<ChatResult>;
  speak(req: SpeechRequest): Promise<SpeechResult>;

  /**
   * Reserved for when the Heart's mic pipeline lands. Declared now so adding STT
   * later is not a breaking change to this interface.
   */
  // transcribe(req: TranscribeRequest): Promise<TranscribeResult>;
}

export function isChatSuccess(r: ChatResult): r is ChatSuccess {
  return r.ok;
}

export function isSpeechSuccess(r: SpeechResult): r is SpeechSuccess {
  return r.ok;
}