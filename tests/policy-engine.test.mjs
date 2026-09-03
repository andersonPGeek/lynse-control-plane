import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePolicy } from '../src/policy-engine.mjs';

test('modo audit registra o risco sem interromper o ABE', () => {
  const result = evaluatePolicy({
    mode: 'audit',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'DROP TABLE customers' },
  });
  assert.equal(result.decision, 'allow');
  assert.equal(result.recorded_decision, 'would_block');
  assert.equal(result.rule_code, 'SEC-DB-04');
});

test('modo enforcement bloqueia operação destrutiva', () => {
  const result = evaluatePolicy({
    mode: 'enforcement',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf /' },
  });
  assert.equal(result.decision, 'block');
  assert.equal(result.risk_level, 'critical');
});

test('alteração destrutiva de Git pede confirmação', () => {
  const result = evaluatePolicy({
    mode: 'enforcement',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git reset --hard HEAD~2' },
  });
  assert.equal(result.decision, 'ask');
  assert.equal(result.rule_code, 'ENG-GIT-02');
});

test('ação comum é permitida', () => {
  const result = evaluatePolicy({
    mode: 'enforcement',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
  });
  assert.equal(result.decision, 'allow');
});

