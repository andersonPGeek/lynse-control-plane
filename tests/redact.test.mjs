import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyText, redactSecrets, sha256 } from '../src/redact.mjs';

test('redige credencial sem perder a categoria', () => {
  const result = redactSecrets('api_key=super-secret-value');
  assert.match(result.text, /REDACTED:credential/);
  assert.ok(!result.text.includes('super-secret-value'));
  assert.deepEqual(result.categories, ['credential']);
});

test('classificação preserva hash e tamanho', () => {
  const result = classifyText('implemente o endpoint');
  assert.equal(result.length, 21);
  assert.equal(result.sha256, sha256('implemente o endpoint'));
});

