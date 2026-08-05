import { ChatRequest,ChatResponse ,AiInterface} from "./interface.js";
import { FallbackManager } from "./fallback-manager.js";



export class AIOrchestrator implements AiInterface {
  constructor(private fallback: FallbackManager) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    return this.fallback.chat(req);
  }
}