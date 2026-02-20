import { GoogleGenAI, Content } from '@google/genai';
import { Message } from '@a2a-js/sdk';
import { prettyJson } from '@agentic-profile/common';
import log from 'loglevel';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
dotenv.config(); // Ugh, duplicate to avoid ESM race conditions


const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY)
    throw new Error("GEMINI_API_KEY is not set");
const ai = new GoogleGenAI({apiKey: GEMINI_API_KEY});

const systemInstruction = fs.readFileSync(path.join(import.meta.dirname, 'instruction.md'), 'utf8');
const profile = fs.readFileSync(path.join(import.meta.dirname, 'profile.md'), 'utf8');

interface DiscoverSynergyParams {
    toAgentDid: string;
    fromAgentDid: string;
    userMessage: Message;
}

export interface Result {
    text: string;
    metadata: any;
    contextId: string;
}

export async function discoverSynergy({toAgentDid, fromAgentDid, userMessage}: DiscoverSynergyParams): Promise<Result> {
    // resolve context
    const contextPrefix = `${toAgentDid}^${fromAgentDid}^`;
    let contextId;
    if (!userMessage.contextId)
        contextId = `${contextPrefix}${Date.now()}`;
    else {
        if (!userMessage.contextId.startsWith(contextPrefix))
            throw new Error("Context ID does not match agent IDs");
        contextId = userMessage.contextId;
    }

    let context = contextMap.get(contextId);
    if (!context) {
        context = { messages: [] };
        contextMap.set(contextId, context);
    }

    // Extract text from the latest user message safely and add to context
    const userText = (userMessage.parts.find(p => (p as any).kind === 'text') as any)?.text;
    if(!userText)
        throw new Error("User message does not contain text");
    context.messages.push({role: 'user', parts: [{ text: userText }] });

    // have we introduced ourselves yet?
    let modelText;
    const hasIntroduced = context.messages.some(m => m.role === 'model');
    if(!hasIntroduced) {
        modelText = "Let me introduce myself.\n\n" +profile;
    } else {
        // To pass history, use the 'contents' parameter with an array of objects.
        // Each object represents a turn and must have a 'role' ('user' or 'model') and 'parts'.
        const params = {
            model: 'gemini-2.5-flash-lite',
            contents: context.messages,
            config: {
                systemInstruction
            }    
        }
        log.debug("Gemini params", prettyJson(params));
        const response = await ai.models.generateContent(params);
        log.debug("Gemini response", response);
        modelText = response.text;
        if( !modelText )
            throw new Error("Model response does not contain text");
    }
    
    // Add model response to context and persist
    context.messages.push({role: 'model', parts: [{ text: modelText }] });
    saveContextMap();

    return { text: modelText, metadata: { resolution: { like: true } }, contextId }
}

// Chat context store — persisted to disk so conversations survive server restarts

interface ChatContext {
    messages: Content[];
}

const CONTEXT_FILE = path.join(process.cwd(), 'logs', 'chat-contexts.json');

function loadContextMap(): Map<string, ChatContext> {
    try {
        const raw = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf-8'));
        return new Map(Object.entries(raw));
    } catch {
        return new Map();
    }
}

function saveContextMap(): void {
    try {
        fs.mkdirSync(path.dirname(CONTEXT_FILE), { recursive: true });
        fs.writeFileSync(CONTEXT_FILE, JSON.stringify(Object.fromEntries(contextMap), null, 2));
    } catch (err) {
        log.error('Failed to save chat contexts:', err);
    }
}

const contextMap = loadContextMap();
