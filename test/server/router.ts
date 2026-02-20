import express from 'express';
import cors from 'cors';
import type { Request, Response, NextFunction, Application } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createDidResolver, InMemoryAgenticProfileStore } from '@agentic-profile/common';
import { createClientAgentSessionStore } from './store.js';

// A2A handlers and helpers
import { handleA2ALiteRequest } from './a2a-service/handler.js';
import { agentCard } from './a2a-service/agent-card.js';
import { createA2ALiteRouter } from '../../src/a2a-service/router.js';

// MCP handlers
import { createPresenceRouter } from "./mcp-service/router.js";

// Authentication/session handlers
const sessionStore = createClientAgentSessionStore();
const profileStore = new InMemoryAgenticProfileStore();
const didResolver = createDidResolver({ store: profileStore });

// Create Express app
const app: Application = express();

// Trust proxy for accurate req.protocol when behind reverse proxy (e.g., AWS API Gateway)
app.set('trust proxy', true);

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'mcp-protocol-version',
        'Content-Type',
        'Authorization',
        'WWW-Authenticate',
        'X-Requested-With',
        'Accept',
        'Origin',
        'Cache-Control',
        'Pragma'
    ],
    exposedHeaders: [
        'Access-Control-Allow-Headers',
        'Access-Control-Allow-Methods',
        'Access-Control-Allow-Origin',
        'WWW-Authenticate'
    ],
    credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Logging middleware to log HTTP method and path
app.use((req, _res, next) => {
    console.log(`Starting ${req.method} ${req.path}`); //, req.body);
    next();
});

// Health check endpoint
const started = new Date().toISOString();
app.get('/status', (req: Request, res: Response) => {
    res.json({
        status: 'healthy',
        started,
        timestamp: new Date().toISOString(),
        service: 'a2a-mcp-express',
        url: req.originalUrl
    });
});

/* Well known did.json
app.get('/.well-known/did.json', (req: Request, res: Response) => {
    wellKnownDidDocument.id = `did:web:${req.get('host')}`;
    res.json(wellKnownDidDocument);
});
*/

app.use('/a2a/hello', createA2ALiteRouter({
    jrpcRequestHandler: handleA2ALiteRequest,
    cardBuilder: agentCard,
    store: sessionStore,
    didResolver,
    requireAuth: true
}));
app.use('/mcp/presence', createPresenceRouter(sessionStore, didResolver));

// Serve the web interface for non-API routes
app.get('/', (_req: Request, res: Response) => {
    res.sendFile('index.html', { root: 'www' });
});

// Chat UI
app.get('/chat', (_req: Request, res: Response) => {
    res.sendFile('chat.html', { root: 'www' });
});

// Simple proxy endpoint that forwards a plain text message to the A2A hello handler
app.post('/chat/send', async (req: Request, res: Response) => {
    try {
        const { text, contextId } = req.body || {};
        if (!text) return res.status(400).json({ error: 'text is required' });

        // Build a minimal A2A Message expected by the handler
        const message = {
            kind: 'message',
            ...(contextId ? { contextId } : {}),
            parts: [{ kind: 'text', text }],
            metadata: {
                // ensure there's an envelope with a recipient that has fragment 'venture'
                envelope: { to: 'did:web:local#venture' }
            }
        };

        // Construct a JSON-RPC request the handler expects
        const jrpcRequest = {
            jsonrpc: '2.0',
            id: `chat-${Date.now()}`,
            method: 'message/send',
            params: { message }
        } as any;

        // Provide a minimal `session` object so handler can read `session.agentDid`
        const context = { session: { agentDid: 'did:web:user#user' } } as any;

        const result = await handleA2ALiteRequest(jrpcRequest, context);
        if (result && 'result' in result) {
            return res.json({ reply: (result as any).result });
        }
        if (result && 'error' in result) {
            return res.status(500).json({ error: result.error });
        }
        return res.status(500).json({ error: 'Unknown handler response' });
    } catch (err: any) {
        const logsDir = path.join(process.cwd(), 'logs');
        try { fs.mkdirSync(logsDir, { recursive: true }); } catch (_) {}
        const logPath = path.join(logsDir, 'chat-errors.log');
        const ts = new Date().toISOString();
        const entry = `${ts} - /chat/send error:\n${err && err.stack ? err.stack : String(err)}\n\n`;
        try { fs.appendFileSync(logPath, entry); } catch (e) { console.error('failed to write chat log', e); }
        console.error('chat/send error', err);
        // Return detailed error for debugging (includes stack)
        res.status(500).json({ error: String(err), stack: err && err.stack ? err.stack : undefined });
    }
});

// Serve static files from www directory (after specific routes)
app.use(express.static('www'));

// Error handling middleware
app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled error:', error);
    res.status(500).json({
        jsonrpc: '2.0',
        id: 'unhandled-error',
        error: {
            code: -32603,
            message: 'Internal error',
            data: error.message
        }
    });
});

export { app }; 
