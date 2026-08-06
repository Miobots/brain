import type {
  AiInterface,
  ChatRequest,
  ChatResult,
  SpeechRequest,
  SpeechResult,
} from './interface.js';
import type { ChatResolver } from './chat-resolver.js';
import type { SpeechResolver } from './speech/speech-resolver.js';
 

export class AiGateway implements AiInterface {
  constructor(
    private readonly chatResolver: ChatResolver,
    private readonly speechResolver: SpeechResolver,
  ) {}
 
  chat(req: ChatRequest): Promise<ChatResult> {
    return this.chatResolver.resolve(req);
  }
 
  speak(req: SpeechRequest): Promise<SpeechResult> {
    return this.speechResolver.speak(req);
  }
}