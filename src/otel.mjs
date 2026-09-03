function anyValue(value = {}) {
  if ('stringValue' in value) return value.stringValue;
  if ('boolValue' in value) return value.boolValue;
  if ('intValue' in value) return Number(value.intValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('bytesValue' in value) return value.bytesValue;
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(anyValue);
  if ('kvlistValue' in value) return attributes(value.kvlistValue.values ?? []);
  return null;
}

export function attributes(items = []) {
  return Object.fromEntries(items.map((item) => [item.key, anyValue(item.value)]));
}

function timestampFromNanos(value) {
  if (!value) return null;
  const millis = Number(BigInt(value) / 1_000_000n);
  return new Date(millis).toISOString();
}

function pointValue(point, type) {
  if (type === 'histogram') return Number(point.sum ?? point.count ?? 0);
  if ('asDouble' in point) return Number(point.asDouble);
  if ('asInt' in point) return Number(point.asInt);
  return null;
}

export function parseMetricRequest(payload = {}) {
  const rows = [];
  for (const resourceMetric of payload.resourceMetrics ?? []) {
    const resourceAttributes = attributes(resourceMetric.resource?.attributes);
    for (const scopeMetric of resourceMetric.scopeMetrics ?? []) {
      for (const metric of scopeMetric.metrics ?? []) {
        const data = metric.sum ?? metric.gauge ?? metric.histogram;
        const type = metric.sum ? 'sum' : metric.histogram ? 'histogram' : 'gauge';
        for (const point of data?.dataPoints ?? []) {
          const merged = { ...resourceAttributes, ...attributes(point.attributes) };
          rows.push({
            signal: 'metric',
            session_id: merged['session.id'] ?? merged.session_id ?? null,
            name: metric.name,
            value: pointValue(point, type),
            temporality: data.aggregationTemporality ?? null,
            attributes: merged,
            payload: {
              description: metric.description ?? null,
              unit: metric.unit ?? null,
              type,
              count: point.count ? Number(point.count) : null,
              min: point.min ? Number(point.min) : null,
              max: point.max ? Number(point.max) : null,
            },
            observed_at: timestampFromNanos(point.timeUnixNano),
          });
        }
      }
    }
  }
  return rows;
}

export function parseLogRequest(payload = {}) {
  const rows = [];
  for (const resourceLog of payload.resourceLogs ?? []) {
    const resourceAttributes = attributes(resourceLog.resource?.attributes);
    for (const scopeLog of resourceLog.scopeLogs ?? []) {
      for (const record of scopeLog.logRecords ?? []) {
        const merged = { ...resourceAttributes, ...attributes(record.attributes) };
        const body = anyValue(record.body);
        rows.push({
          signal: 'log',
          session_id: merged['session.id'] ?? merged.session_id ?? null,
          name: merged['event.name'] ?? record.eventName ?? 'claude_code.event',
          value: null,
          temporality: null,
          attributes: merged,
          payload: { body, severity_text: record.severityText ?? null },
          observed_at: timestampFromNanos(record.timeUnixNano ?? record.observedTimeUnixNano),
        });
      }
    }
  }
  return rows;
}

export function summarizeMeasurements(rows = []) {
  const grouped = new Map();
  for (const row of rows) {
    if (row.signal !== 'metric' || row.value === null) continue;
    const key = `${row.name}|${JSON.stringify(row.attributes ?? {})}`;
    const current = grouped.get(key);
    const value = Number(row.value);
    if (!current) {
      grouped.set(key, { name: row.name, value, temporality: row.temporality });
    } else if (Number(row.temporality) === 1) {
      current.value += value;
    } else {
      current.value = Math.max(current.value, value);
    }
  }

  return [...grouped.values()].reduce((summary, item) => {
    summary[item.name] = (summary[item.name] ?? 0) + item.value;
    return summary;
  }, {});
}
