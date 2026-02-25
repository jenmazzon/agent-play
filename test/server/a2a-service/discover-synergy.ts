import { GoogleGenAI, Content } from '@google/genai';
import { Message } from '@a2a-js/sdk';
import { prettyJson } from '@agentic-profile/common';
import { trace, SpanKind, SpanStatusCode, TraceFlags, ROOT_CONTEXT } from '@opentelemetry/api';
import { flushTraces } from '../../../src/telemetry/index.js';
import log from 'loglevel';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
dotenv.config(); // Ugh, duplicate to avoid ESM race conditions

// GenAI semantic convention attribute names (OTel spec v1.26+)
const GEN_AI_SYSTEM = 'gen_ai.system';
const GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';
const GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';
const GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
const GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';

const MODEL = 'gemini-2.5-flash-lite';
const genAiTracer = trace.getTracer('@google/genai');
const captureMessageContent = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT === 'true';


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

    let chatCtx = contextMap.get(contextId);
    if (!chatCtx) {
        chatCtx = {
            messages: [],
            traceId: randomBytes(16).toString('hex'),
            rootSpanId: randomBytes(8).toString('hex'),
        };
        contextMap.set(contextId, chatCtx);
    }

    // Extract text from the latest user message safely and add to context
    const userText = (userMessage.parts.find(p => (p as any).kind === 'text') as any)?.text;
    if(!userText)
        throw new Error("User message does not contain text");
    chatCtx.messages.push({role: 'user', parts: [{ text: userText }] });

    // have we introduced ourselves yet?
    let modelText;
    const hasIntroduced = chatCtx.messages.some(m => m.role === 'model');
    if(!hasIntroduced) {
        modelText = "Let me introduce myself.\n\n" +profile;
    } else {
        // To pass history, use the 'contents' parameter with an array of objects.
        // Each object represents a turn and must have a 'role' ('user' or 'model') and 'parts'.
        const params = {
            model: MODEL,
            contents: chatCtx.messages,
            config: {
                systemInstruction
            }
        }
        log.debug("Gemini params", prettyJson(params));

        // All turns of a conversation share a traceId so they appear together in Convex
        const conversationSpanCtx = {
            traceId: chatCtx.traceId,
            spanId: chatCtx.rootSpanId,
            traceFlags: TraceFlags.SAMPLED,
            isRemote: true,
        };
        const parentCtx = trace.setSpanContext(ROOT_CONTEXT, conversationSpanCtx);

        const response = await genAiTracer.startActiveSpan(
            `chat ${MODEL}`,
            { kind: SpanKind.CLIENT },
            parentCtx,
            async (span) => {
                span.setAttributes({
                    [GEN_AI_SYSTEM]: 'gemini',
                    [GEN_AI_OPERATION_NAME]: 'chat',
                    [GEN_AI_REQUEST_MODEL]: MODEL,
                    'conversation.id': contextId,
                });
                // Capture prompt/completion content only when explicitly opted in (mirrors
                // OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT convention from the
                // opentelemetry-instrumentation-google-genai spec)
                if (captureMessageContent) {
                    span.addEvent('gen_ai.content.prompt', { 'gen_ai.prompt': userText });
                }
                try {
                    const res = await ai.models.generateContent(params);
                    const usage = res.usageMetadata;
                    if (usage) {
                        span.setAttributes({
                            [GEN_AI_USAGE_INPUT_TOKENS]: usage.promptTokenCount ?? 0,
                            [GEN_AI_USAGE_OUTPUT_TOKENS]: usage.candidatesTokenCount ?? 0,
                        });
                    }
                    if (captureMessageContent) {
                        // Strip injected metadata JSON before recording completion text
                        const rawText = res.text ?? '';
                        const metaIdx = rawText.search(/\{\s*"metadata"\s*:/);
                        const completionText = metaIdx >= 0 ? rawText.slice(0, metaIdx).trimEnd() : rawText;
                        span.addEvent('gen_ai.content.completion', { 'gen_ai.completion': completionText });
                    }
                    span.setStatus({ code: SpanStatusCode.OK });
                    return res;
                } catch (err: any) {
                    span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
                    throw err;
                } finally {
                    span.end();
                }
            }
        );
        log.debug("Gemini response", response);
        modelText = response.text;
        if( !modelText )
            throw new Error("Model response does not contain text");
    }

    // Strip metadata JSON that Gemini appends as a synergy signal per the system instruction.
    // Capture it as structured data rather than letting it appear in the displayed text.
    let metadata: any = {};
    const metaMatch = modelText.match(/\{\s*"metadata"\s*:\s*(\{[\s\S]*?\})\s*\}/);
    if (metaMatch) {
        try {
            const parsed = JSON.parse(metaMatch[0]);
            if (parsed?.metadata) metadata = parsed.metadata;
        } catch (_) {}
        modelText = modelText.slice(0, metaMatch.index).trimEnd();
    }

    // Add model response to context and persist
    chatCtx.messages.push({role: 'model', parts: [{ text: modelText }] });
    saveContextMap();
    flushTraces().catch((err: any) => log.error('flushTraces failed:', err));

    return { text: modelText, metadata, contextId }
}

// Chat context store — persisted to disk so conversations survive server restarts

interface ChatContext {
    messages: Content[];
    traceId: string;    // shared across all turns — links turns into one trace
    rootSpanId: string; // virtual parent spanId so all turns appear as siblings
}

const CONTEXT_FILE = path.join(process.cwd(), 'logs', 'chat-contexts.json');

function loadContextMap(): Map<string, ChatContext> {
    try {
        const raw = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf-8'));
        const map = new Map<string, ChatContext>();
        for (const [k, v] of Object.entries(raw as Record<string, any>)) {
            map.set(k, {
                messages: v.messages ?? [],
                traceId: v.traceId ?? randomBytes(16).toString('hex'),
                rootSpanId: v.rootSpanId ?? randomBytes(8).toString('hex'),
            });
        }
        return map;
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
