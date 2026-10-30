import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

/**
 * Traces to OTEL_EXPORTER_OTLP_ENDPOINT when it is set. Call it before anything else is imported
 * (its own entry, `@d4/runtime/telemetry`), so instrumentation can patch the HTTP and DB drivers.
 */
export function startTelemetry(serviceName: string): NodeSDK | undefined {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return undefined;
  const sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    instrumentations: [getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } })],
  });
  sdk.start();
  return sdk;
}
