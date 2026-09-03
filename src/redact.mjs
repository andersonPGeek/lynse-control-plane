import { createHash } from 'node:crypto';

const SECRET_PATTERNS = [
  { label: 'private_key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi },
  { label: 'aws_access_key', regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { label: 'bearer_token', regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi },
  { label: 'credential', regex: /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["']?[^\s,"']{6,}/gi },
];

export function sha256(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

export function redactSecrets(value) {
  let text = String(value ?? '');
  const categories = [];
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(text)) categories.push(pattern.label);
    pattern.regex.lastIndex = 0;
    text = text.replace(pattern.regex, `[REDACTED:${pattern.label}]`);
  }
  return { text, categories: [...new Set(categories)] };
}

export function classifyText(value) {
  const original = String(value ?? '');
  const redacted = redactSecrets(original);
  return {
    sha256: sha256(original),
    length: original.length,
    categories: redacted.categories,
    redacted_preview: redacted.text.slice(0, 240),
  };
}

export function safeJson(value, maxLength = 20_000) {
  const serialized = JSON.stringify(value ?? {});
  const { text, categories } = redactSecrets(serialized);
  return {
    value: text.length > maxLength ? { truncated_json: text.slice(0, maxLength) } : JSON.parse(text),
    redacted_categories: categories,
    truncated: text.length > maxLength,
  };
}
