import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMetricRequest, summarizeMeasurements } from '../src/otel.mjs';

function metricPayload(value, temporality = 2) {
  return {
    resourceMetrics: [{
      resource: { attributes: [{ key: 'session.id', value: { stringValue: 'session-123' } }] },
      scopeMetrics: [{
        metrics: [{
          name: 'claude_code.token.usage',
          unit: 'tokens',
          sum: {
            aggregationTemporality: temporality,
            dataPoints: [{ asInt: String(value), timeUnixNano: '1756684800000000000' }],
          },
        }],
      }],
    }],
  };
}

test('converte OTLP JSON em medições correlacionadas à sessão', () => {
  const rows = parseMetricRequest(metricPayload(1200));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_id, 'session-123');
  assert.equal(rows[0].value, 1200);
});

test('para contador cumulativo usa o maior valor observado', () => {
  const rows = [
    ...parseMetricRequest(metricPayload(100, 2)),
    ...parseMetricRequest(metricPayload(250, 2)),
  ];
  assert.equal(summarizeMeasurements(rows)['claude_code.token.usage'], 250);
});

test('para contador delta soma os intervalos', () => {
  const rows = [
    ...parseMetricRequest(metricPayload(100, 1)),
    ...parseMetricRequest(metricPayload(250, 1)),
  ];
  assert.equal(summarizeMeasurements(rows)['claude_code.token.usage'], 350);
});

