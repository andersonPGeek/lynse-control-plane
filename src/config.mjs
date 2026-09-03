function integer(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} deve ser um inteiro positivo`);
  }
  return value;
}

function enumValue(name, allowed, fallback) {
  const value = process.env[name] ?? fallback;
  if (!allowed.includes(value)) {
    throw new Error(`${name} deve ser um de: ${allowed.join(', ')}`);
  }
  return value;
}

export const config = Object.freeze({
  port: integer('PORT', 3333),
  databaseUrl:
    process.env.DATABASE_URL ??
    'postgres://lynse:lynse@localhost:5432/lynse_control_plane',
  apiKey: process.env.LYNSE_API_KEY ?? 'change-me-local',
  defaultMode: enumValue('LYNSE_DEFAULT_MODE', ['audit', 'enforcement'], 'audit'),
  failMode: enumValue('LYNSE_FAIL_MODE', ['open', 'closed'], 'open'),
  bodyLimitBytes: integer('LYNSE_BODY_LIMIT_BYTES', 5 * 1024 * 1024),
});

