import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceUsageRows } from '../src/analytics.mjs';

function row(overrides) {
  return {
    name: 'claude_code.token.usage',
    value: 100,
    temporality: 1,
    attributes: { 'session.id': 's1', model: 'm', type: 'input' },
    observed_at: new Date('2026-11-01T10:00:00Z'),
    session_id: 's1',
    execution_id: 'e1',
    ...overrides,
  };
}

const total = (result) => result.rows.reduce((sum, r) => sum + r.value, 0);

test('DELTA soma intervalos diferentes', () => {
  const result = reduceUsageRows([
    row({ observed_at: new Date('2026-11-01T10:00:00Z') }),
    row({ observed_at: new Date('2026-11-01T10:00:05Z'), value: 50 }),
  ]);
  assert.equal(total(result), 150);
});

test('lote reenviado (linhas idênticas) não é somado duas vezes', () => {
  const result = reduceUsageRows([row({}), row({}), row({})]);
  assert.equal(total(result), 100);
  assert.equal(result.diagnostics.duplicate_rows_removed, 2);
});

test('CUMULATIVE usa o maior valor da série', () => {
  const result = reduceUsageRows([
    row({ temporality: 2, value: 10, observed_at: new Date('2026-11-01T10:00:00Z') }),
    row({ temporality: 2, value: 40, observed_at: new Date('2026-11-01T10:00:05Z') }),
    row({ temporality: 2, value: 25, observed_at: new Date('2026-11-01T10:00:10Z') }),
  ]);
  assert.equal(total(result), 40);
});

test('séries com atributos diferentes (agente principal x subagente) são somadas, não colapsadas', () => {
  const main = { 'session.id': 's1', model: 'm', type: 'output', query_source: 'main' };
  const sub = { 'session.id': 's1', model: 'm', type: 'output', query_source: 'subagent' };
  const result = reduceUsageRows([
    row({ temporality: 2, value: 30, attributes: main }),
    row({ temporality: 2, value: 70, attributes: sub }),
  ]);
  assert.equal(total(result), 100);
});
