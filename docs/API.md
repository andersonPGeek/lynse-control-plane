# API do Control Plane

Base local: `http://localhost:3333`. Todas as rotas, exceto `/health`, exigem `x-api-key`.

## Fluxo principal

| Método | Rota | Finalidade |
|---|---|---|
| `GET` | `/health` | saúde da API e do PostgreSQL |
| `POST` | `/api/v1/executions/start` | abre e correlaciona uma User Story |
| `GET` | `/api/v1/executions` | lista execuções, com filtros de status e limite |
| `POST` | `/api/v1/events` | recebe um evento normalizado de hook |
| `POST` | `/api/v1/policies/evaluate` | avalia ALLOW, ASK ou BLOCK e registra a decisão |
| `POST` | `/api/v1/approvals` | registra gate humano |
| `PATCH` | `/api/v1/executions/{id}/status` | muda a etapa da execução |
| `GET` | `/api/v1/executions/{id}` | retorna execução e relacionamentos |
| `GET` | `/api/v1/executions/{id}/summary` | retorna visão consolidada para o ABE |
| `POST` | `/api/v1/executions/{id}/complete` | encerra a execução |
| `POST` | `/api/v1/integrations/pr` | registra ou atualiza um PR |
| `POST` | `/api/v1/integrations/deploy` | registra um deploy |
| `POST` | `/otel/v1/metrics` | recebe OTLP/HTTP JSON de métricas |
| `POST` | `/otel/v1/logs` | recebe OTLP/HTTP JSON de logs/eventos |

## Abrir execução

```bash
curl -X POST http://localhost:3333/api/v1/executions/start \
  -H 'content-type: application/json' \
  -H 'x-api-key: change-me-local' \
  -d '{
    "external_ref": "US-1842",
    "project_slug": "customer-portal",
    "repository_slug": "customer-api",
    "abe_email": "anderson@lynse.ai",
    "claude_session_id": "session-demo",
    "mode": "audit"
  }'
```

## Avaliar política

```bash
curl -X POST http://localhost:3333/api/v1/policies/evaluate \
  -H 'content-type: application/json' \
  -H 'x-api-key: change-me-local' \
  -d '{
    "execution_id": "<EXECUTION_ID>",
    "claude_session_id": "session-demo",
    "hook_event_name": "PreToolUse",
    "tool_name": "Bash",
    "tool_input": {"command": "DROP TABLE customers"},
    "mode": "enforcement"
  }'
```

Resposta relevante:

```json
{
  "decision": "block",
  "recorded_decision": "block",
  "rule_code": "SEC-DB-04",
  "risk_level": "critical",
  "mode": "enforcement"
}
```

## Registrar aprovação

```bash
curl -X POST http://localhost:3333/api/v1/approvals \
  -H 'content-type: application/json' \
  -H 'x-api-key: change-me-local' \
  -d '{
    "execution_id": "<EXECUTION_ID>",
    "abe_email": "anderson@lynse.ai",
    "gate": "plan",
    "decision": "approved",
    "rationale": "Plano cobre critérios e riscos"
  }'
```

## Registrar Pull Request

```bash
curl -X POST http://localhost:3333/api/v1/integrations/pr \
  -H 'content-type: application/json' \
  -H 'x-api-key: change-me-local' \
  -d '{
    "execution_id": "<EXECUTION_ID>",
    "provider": "github",
    "external_id": "482",
    "url": "https://github.com/example/customer-api/pull/482",
    "status": "merged",
    "merged_at": "2026-09-03T15:00:00Z"
  }'
```

## Registrar deploy

```bash
curl -X POST http://localhost:3333/api/v1/integrations/deploy \
  -H 'content-type: application/json' \
  -H 'x-api-key: change-me-local' \
  -d '{
    "execution_id": "<EXECUTION_ID>",
    "environment": "prod",
    "status": "succeeded",
    "version": "git-sha-abc123",
    "url": "https://customer-api.example.com"
  }'
```

Um deploy de produção bem-sucedido move a execução para `observing`. O endpoint `complete` exige os gates `plan`, `pr` e `deploy`, além de um deploy de produção bem-sucedido.

O contrato completo e importável está em [`openapi.yaml`](openapi.yaml).
