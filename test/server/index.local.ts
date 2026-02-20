import dotenv from 'dotenv';
dotenv.config();

// Initialize OpenTelemetry (sends spans to the OTLP HTTP endpoint)
import '../../src/telemetry/index.js';

import log from 'loglevel';
log.setLevel('debug');

import { app } from './router.js';

const PORT = process.env.PORT || 4004;

// Local HTTP server for development
// This starts an Express server directly (not wrapped in Lambda)
const server = app.listen(PORT, () => {
    console.log(`🚀 Local HTTP server started on port ${PORT}`);
    console.log(`📡 Landing page: http://localhost:${PORT}`);
    console.log(`🔍 Status: http://localhost:${PORT}/status`);

    console.log(`🚀 A2A Hello endpoint: http://localhost:${PORT}/a2a/hello`);
    console.log(`🚀 MCP presence endpoint: http://localhost:${PORT}/mcp/presence`);

    console.log(`⏹️  Press Ctrl+C to stop the server`);
});

// Graceful shutdown
const shutdown = (signal: string) => {
    console.log(`\n🛑 Received ${signal}, shutting down local server...`);
    server.close(() => {
        console.log('✅ Local server stopped');
        process.exit(0);
    });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});