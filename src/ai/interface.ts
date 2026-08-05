export interface ChatRequest{
    corrId: string;
    transcript:string;
    lang: 'ur'|'en'|'mixed';
    systemPrompt?:string;
}

export interface ChatResponse{
    text:string
    modelUsed:string
    attempts:number
}

export interface AiInterface{
    chat(req: ChatRequest):Promise<ChatResponse>;
}
