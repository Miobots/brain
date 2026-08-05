import { customProvider} from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";

export const registry = customProvider({
  languageModels: {
    reasoning: anthropic("claude-sonnet-5"),
    gpt: openai("gpt-5"),
    gemini: google("gemini-2.5-flash"),
  },
});

export class ModelRegistry{
    get(name:string){
        const model = registry.languageModel(name)
        if(!model){
            throw new Error(`Unknown model alias : ${name}`)
        }
        return model
    }
}