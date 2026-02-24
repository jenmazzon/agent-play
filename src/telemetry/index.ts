import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { diag, DiagConsoleLogger, DiagLogLevel, trace } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);

const url = process.env.OTEL_COLLECTOR_URL || 'https://jovial-alpaca-276.convex.site/spans/otel';
const traceExporter = new OTLPTraceExporter({ url });

// Use NodeTracerProvider directly so we have a concrete reference for forceFlush.
// NodeSDK wraps it in a ProxyTracerProvider which does NOT expose forceFlush.
const tracerProvider = new NodeTracerProvider({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'a2a-mcp-express',
  }),
});

tracerProvider.addSpanProcessor(new BatchSpanProcessor(traceExporter));
tracerProvider.register(); // synchronously sets the global tracer provider

console.log('OpenTelemetry provider registered — sending traces to', url);

// Exported so other modules (e.g. discover-synergy) can flush after emitting spans
export function flushTraces(): Promise<void> {
  return tracerProvider.forceFlush();
}

// Startup smoke span
try {
  const tracer = trace.getTracer('startup-smoke');
  const span = tracer.startSpan('smoke-startup');
  span.end();
  flushTraces().catch((err: any) => console.error('forceFlush failed:', err));
} catch (err) {
  console.error('Error creating smoke span:', err);
}

// Periodic smoke spans
let periodicTimer: ReturnType<typeof setInterval> | null = null;
const periodicTracer = trace.getTracer('periodic-smoke');
periodicTimer = setInterval(() => {
  try {
    const span = periodicTracer.startSpan('smoke-periodic');
    span.setAttribute('env', process.env.NODE_ENV || 'development');
    span.end();
    flushTraces().catch((err: any) => console.error('forceFlush failed:', err));
  } catch (err) {
    console.error('Error emitting periodic span:', err);
  }
}, 30000);

function shutdown() {
  if (periodicTimer) {
    clearInterval(periodicTimer);
    periodicTimer = null;
  }
  tracerProvider.shutdown()
    .then(() => console.log('OpenTelemetry provider shutdown complete'))
    .catch((err: any) => console.error('Provider shutdown error:', err));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
