import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { trace } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

// Enable info-level diagnostics so exporter errors are visible
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);

const url = process.env.OTEL_COLLECTOR_URL || 'https://jovial-alpaca-276.convex.site/spans/otel';

const traceExporter = new OTLPTraceExporter({ url });

const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'a2a-mcp-express',
  }),
  traceExporter,
  instrumentations: [getNodeAutoInstrumentations({
    // Disable instrumentations that cause "ended Span" warnings or generate noise
    '@opentelemetry/instrumentation-http': { enabled: false },
    '@opentelemetry/instrumentation-fs': { enabled: false },
    '@opentelemetry/instrumentation-grpc': { enabled: false },
  })]
});

// Flush via the global tracer provider (NodeSDK v0.34 has no forceFlush on sdk itself)
function flushTraces(): Promise<void> {
  return trace.getTracerProvider().forceFlush?.() ?? Promise.resolve();
}

// Periodically emit spans so we can verify ongoing delivery
let periodicTimer: NodeJS.Timer | null = null;
function startPeriodicSpans() {
  const tracer = trace.getTracer('periodic-smoke');
  periodicTimer = setInterval(() => {
    try {
      const span = tracer.startSpan('smoke-periodic');
      span.setAttribute('env', process.env.NODE_ENV || 'development');
      span.end();
      flushTraces().catch((err: any) => console.error('forceFlush failed:', err));
    } catch (err) {
      console.error('Error emitting periodic span:', err);
    }
  }, 30000); // every 30 s — reduce noise
}

sdk.start().then(() => {
  console.log('OpenTelemetry SDK started — sending smoke span to', url);
  try {
    const tracer = trace.getTracer('startup-smoke');
    const span = tracer.startSpan('smoke-startup');
    span.end();
    flushTraces().catch((err: any) => console.error('forceFlush failed:', err));
  } catch (err) {
    console.error('Error creating smoke span:', err);
  }
  startPeriodicSpans();
}).catch((err) => {
  console.error('OpenTelemetry SDK failed to start:', err);
});

function shutdown() {
  if (periodicTimer) {
    clearInterval(periodicTimer);
    periodicTimer = null;
  }
  sdk.shutdown().then(() => console.log('OpenTelemetry SDK shutdown complete')).catch((err: any) => console.error('SDK shutdown error:', err));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { sdk };
