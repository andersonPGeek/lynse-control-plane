import { sha256 } from './redact.mjs';

const RULES = [
  {
    code: 'SEC-SECRET-01',
    risk: 'critical',
    action: 'block',
    reason: 'Possível credencial ou chave privada detectada antes do envio ao modelo.',
    test: (text) => /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["']?[^\s,"']{6,}/i.test(text),
  },
  {
    code: 'SEC-DB-04',
    risk: 'critical',
    action: 'block',
    reason: 'Operação destrutiva de banco bloqueada. Exige procedimento controlado e aprovação humana.',
    test: (text) => /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b|\bTRUNCATE\s+(?:TABLE\s+)?[^;\s]+/i.test(text),
  },
  {
    code: 'SEC-FS-03',
    risk: 'critical',
    action: 'block',
    reason: 'Remoção recursiva ou abrangente de arquivos bloqueada.',
    test: (text) => /\brm\s+(?:-[a-z]*r[a-z]*f|-rf|-fr)\s+(?:\/|~|\$HOME|\.\.\/|\.\/\*)/i.test(text),
  },
  {
    code: 'ENG-GIT-02',
    risk: 'high',
    action: 'ask',
    reason: 'Alteração destrutiva de histórico Git exige confirmação do ABE.',
    test: (text) => /\bgit\s+(?:reset\s+--hard|push\s+[^\n]*--force(?:-with-lease)?|clean\s+-[a-z]*f)/i.test(text),
  },
  {
    code: 'OPS-PROD-01',
    risk: 'high',
    action: 'ask',
    reason: 'Ação em produção exige o gate de deploy da Operação Lynse.',
    test: (text) => /\b(?:kubectl|helm|terraform|aws|gcloud|az)\b[^\n]*(?:prod|production)\b|\bdeploy\b[^\n]*(?:prod|production)\b/i.test(text),
  },
  {
    code: 'SEC-CONFIG-02',
    risk: 'high',
    action: 'ask',
    reason: 'Alteração em arquivo sensível exige confirmação e revisão do diff.',
    test: (text) => /(?:^|[/\\])(?:\.env(?:\.|$)|credentials(?:\.|$)|secrets?(?:\.|[/\\]))/i.test(text),
  },
];

const RISK_WEIGHT = { low: 1, medium: 2, high: 3, critical: 4 };
const ACTION_WEIGHT = { allow: 1, ask: 2, block: 3 };

export function evaluatePolicy(input = {}) {
  const mode = input.mode === 'enforcement' ? 'enforcement' : 'audit';
  const inspected = JSON.stringify({
    hook_event_name: input.hook_event_name,
    tool_name: input.tool_name,
    tool_input: input.tool_input,
    prompt: input.prompt,
  });
  const matches = RULES.filter((rule) => rule.test(inspected));

  if (matches.length === 0) {
    return {
      decision: 'allow',
      recorded_decision: 'allow',
      rule_code: 'LYNSE-ALLOW',
      risk_level: 'low',
      reason: 'Nenhuma política restritiva foi acionada.',
      input_hash: sha256(inspected),
      matches: [],
    };
  }

  const dominant = [...matches].sort((a, b) => {
    const action = ACTION_WEIGHT[b.action] - ACTION_WEIGHT[a.action];
    return action || RISK_WEIGHT[b.risk] - RISK_WEIGHT[a.risk];
  })[0];
  const effective = mode === 'audit' ? 'allow' : dominant.action;

  return {
    decision: effective,
    recorded_decision: mode === 'audit' ? 'would_block' : dominant.action,
    rule_code: dominant.code,
    risk_level: dominant.risk,
    reason:
      mode === 'audit'
        ? `[AUDIT] ${dominant.reason}`
        : dominant.reason,
    input_hash: sha256(inspected),
    matches: matches.map(({ code, risk, action, reason }) => ({ code, risk, action, reason })),
  };
}

