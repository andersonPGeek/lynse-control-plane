# API do Control Plane

Base local: `http://localhost:3333`. Todas as rotas, exceto `/health`, exigem `x-api-key`.

## Fluxo principal

| Método | Rota | Finalidade |
|---|---|---|
| `GET` | `/health` | saúde da API e do PostgreSQL |
| `POST` | `/api/v1/executions/start` | abre e correlaciona uma User Story |
| `GET` | `/api/v1/executions` | lista execuções, com filtros de status e limite |
| `POST` | `/api/v1/events` | recebe um evento normalizado de hook |
| `POST` | `/api/v1/policies/record` | registra uma decisão de política **já tomada no hook, na máquina do dev** (regra, risco, modo, hash — sem texto bruto). É o caminho usado pelo `client-kit` |
| `POST` | `/api/v1/policies/evaluate` | avalia ALLOW, ASK ou BLOCK no servidor e registra a decisão. **Recebe o texto bruto do prompt/ferramenta** — mantido só para kits antigos; não usar em instalações novas |
| `POST` | `/api/v1/approvals` | registra gate humano |
| `PATCH` | `/api/v1/executions/{id}/status` | muda a etapa da execução |
| `GET` | `/api/v1/executions/{id}` | retorna execução e relacionamentos |
| `GET` | `/api/v1/executions/{id}/summary` | retorna visão consolidada para o ABE |
| `POST` | `/api/v1/executions/{id}/complete` | encerra a execução |
| `POST` | `/api/v1/integrations/pr` | registra ou atualiza um PR |
| `POST` | `/api/v1/integrations/deploy` | registra um deploy |
| `POST` | `/otel/v1/metrics` | recebe OTLP/HTTP JSON de métricas |
| `POST` | `/otel/v1/logs` | recebe OTLP/HTTP JSON de logs/eventos |
| `GET` | `/api/v1/analytics/summary` | KPIs do período e do período anterior (iniciadas, concluídas, taxa de conclusão, lead time mediano/p90, exceções de política), política por regra, deploys e eventos |
| `GET` | `/api/v1/analytics/organizations` | comparativo por organização |
| `GET` | `/api/v1/analytics/projects` | comparativo por projeto |
| `GET` | `/api/v1/analytics/actors` | comparativo por ABE (inclui aprovações) |
| `GET` | `/api/v1/analytics/timeseries` | um ponto por dia: iniciadas (pela data de início) e concluídas (pela data de conclusão) |
| `GET` | `/api/v1/analytics/filters` | organizações e projetos disponíveis para os filtros |
| `GET` | `/api/v1/analytics/executions` | execuções iniciadas ou concluídas no período e todas as abertas (até 500), com as aprovações de cada uma, última atividade e nº de sessões |
| `GET` | `/dashboard` | página HTML com os gráficos e tabelas de indicadores (sem `x-api-key`; a chave é informada na própria página) |
| `POST` | `/api/v1/admin/api-keys` | cria um ABE (se necessário) e uma chave pessoal para ele — **requer a chave administrativa** |
| `GET` | `/api/v1/admin/api-keys` | lista as chaves emitidas (sem expor o valor) — **requer a chave administrativa** |
| `POST` | `/api/v1/admin/api-keys/{id}/revoke` | revoga uma chave — **requer a chave administrativa** |
| `GET` | `/api/v1/me` | papel da chave usada (`admin` ou `abe`) |
| `GET` | `/api/v1/admin/actors` | todos os ABEs com chaves ativas, execuções e última atividade — **requer a chave administrativa** |
| `GET` | `/api/v1/admin/actors/{id}/impact` | prévia do que será apagado ao excluir o ABE — **requer a chave administrativa** |
| `DELETE` | `/api/v1/admin/actors/{id}` | exclui o ABE e todo o histórico dele; exige `{"confirm_email": "<e-mail do ABE>"}` no corpo. Dados compartilhados com outros ABEs são preservados — **requer a chave administrativa** |

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

## Chaves por desenvolvedor

A chave em `LYNSE_API_KEY` (`config.apiKey`) é a **chave administrativa** — só ela pode gerenciar chaves. Cada desenvolvedor deve receber uma chave pessoal em vez de usar a administrativa no dia a dia:

```bash
curl -X POST https://lynse-control-plane.onrender.com/api/v1/admin/api-keys \
  -H 'content-type: application/json' \
  -H 'x-api-key: <CHAVE ADMINISTRATIVA>' \
  -d '{"email": "dev@empresa.com", "display_name": "Nome do Dev"}'
```

A resposta traz `api_key` em texto puro **uma única vez** — não fica recuperável depois, só o hash é armazenado. Com uma chave pessoal, o `/api/v1/executions/start` não exige mais `project_slug`/`repository_slug` pré-cadastrados nem `abe_email`: a organização e a identidade do ABE vêm da própria chave, e o projeto/repositório são criados automaticamente na primeira execução se ainda não existirem (sempre dentro da organização do dono da chave). A chave administrativa mantém o comportamento antigo (exige tudo explícito, não cria nada automaticamente).

Revogar:
```bash
curl -X POST https://lynse-control-plane.onrender.com/api/v1/admin/api-keys/<ID>/revoke \
  -H 'x-api-key: <CHAVE ADMINISTRATIVA>'
```

## Indicadores (analytics)

```bash
curl http://localhost:3333/api/v1/analytics/summary -H 'x-api-key: change-me-local'
curl http://localhost:3333/api/v1/analytics/projects?organization_slug=lynse-demo -H 'x-api-key: change-me-local'
curl http://localhost:3333/api/v1/analytics/actors?project_slug=agilhes-process-v1 -H 'x-api-key: change-me-local'
curl http://localhost:3333/api/v1/analytics/timeseries?days=30 -H 'x-api-key: change-me-local'
```

Todas as rotas de analytics são somente leitura e aceitam os **mesmos três filtros**: `organization_slug`, `project_slug` e `days` (1 a 3650, padrão 30; 3650 equivale a "todo o período"). O período anterior usado nas variações é a janela de mesmo tamanho imediatamente antes.

O `summary` também traz `last_done_at`, a data da última conclusão no escopo, independente do período.

Regras de contagem:
- **Iniciadas**: `started_at` dentro do período.
- **Concluídas**: status `done` com `ended_at` dentro do período (não pela data de início).
- **Em andamento** e **bloqueadas**: retrato do momento, sem filtro de período (mas com filtro de organização/projeto).
- **Lead time**: mediana e p90 de `ended_at - started_at` das concluídas no período (tempo de relógio). Não há mais média aritmética.
- **Política, deploys, eventos**: pela data do registro (`created_at`, `started_at`, `occurred_at`).
- **Consumo**: pela data da medição OTLP (`observed_at`, ou `received_at` se ausente). Dias da série são calculados no fuso `LYNSE_TIMEZONE` (padrão `America/Sao_Paulo`).

O dashboard em `/dashboard` consome exatamente essas rotas.

O contrato completo e importável está em [`openapi.yaml`](openapi.yaml).
