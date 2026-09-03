# Guia de configuração do Claude Code

Este guia parte de um computador de desenvolvimento novo para chegar à primeira execução rastreada da Operação Lynse.

## 1. Entenda o que será configurado

O ABE — **AI Build Engineer** — continua trabalhando no Claude Code. Três peças são acrescentadas ao repositório:

1. `.claude/settings.json` associa eventos do Claude Code ao hook Lynse;
2. `.claude/skills/` disponibiliza os comandos `/lynse-*`;
3. `.env.lynse` identifica API, projeto, repositório, ABE e modo de governança.

O hook não substitui o Claude Code e a SPEC não é um interceptor. O hook observa e pode decidir antes de uma ferramenta; a SPEC orienta o raciocínio; o Control Plane guarda e correlaciona tudo.

## 2. Pré-requisitos

- Docker Desktop ou Docker Engine com `docker compose`;
- Node.js 20.12 ou superior no computador do ABE;
- Git;
- Claude Code instalado e autenticado;
- portas locais `3333` e `5432` disponíveis.

Confirme:

```bash
docker compose version
node --version
git --version
claude --version
```

## 3. Configure o Control Plane

Na raiz deste projeto:

```bash
cp .env.example .env
docker compose up --build -d
```

O Compose inicia PostgreSQL, aplica `database/001_schema.sql`, carrega `database/002_seed.sql` e publica a API na porta `3333`.

Valide:

```bash
curl http://localhost:3333/health
docker compose ps
```

Resposta esperada do health check:

```json
{
  "status": "ok",
  "service": "lynse-control-plane"
}
```

Se preferir executar a API fora do Docker:

```bash
docker compose up -d postgres
cp .env.example .env
npm install
npm run db:setup
npm start
```

## 4. Configure a identidade da execução

Crie o arquivo local de ambiente:

```bash
cp .env.lynse.example .env.lynse
```

Ajuste estes valores:

```dotenv
LYNSE_API_URL=http://localhost:3333
LYNSE_API_KEY=change-me-local
LYNSE_PROJECT_SLUG=customer-portal
LYNSE_REPOSITORY_SLUG=customer-api
LYNSE_ABE_EMAIL=anderson@lynse.ai
LYNSE_MODE=audit
LYNSE_CAPTURE_MODE=classified
```

`LYNSE_API_KEY` deve ser igual no serviço e no cliente. O arquivo está no `.gitignore` e não deve ser commitado.

## 5. Confira hooks e comandos

Os hooks já estão em `.claude/settings.json`. Os executáveis usados por eles ficam em `.claude/hooks/`. Os comandos ficam em `.claude/skills/<comando>/SKILL.md`, o formato de project skills do Claude Code.

Ao abrir o Claude Code, use `/hooks` para inspecionar os hooks carregados. Os principais são:

| Evento | O que a POC faz |
|---|---|
| `UserPromptSubmit` | classifica o prompt, avalia DLP/política e registra o evento |
| `PreToolUse` | avalia Bash e alterações de arquivos antes da execução |
| `PostToolUse` | registra resultado e snapshot agregado do `git diff --numstat` |
| `PostToolUseFailure` | registra falha de ferramenta |
| `InstructionsLoaded` | comprova o carregamento de instruções |
| `SubagentStart/Stop` | registra trabalho de subagentes |
| `TaskCreated/Completed` | registra tarefas internas do agente |
| `Stop` e `SessionEnd` | delimitam ciclos e sessões |

## 6. Inicie o Claude Code com a telemetria Lynse

macOS ou Linux:

```bash
chmod +x scripts/run-claude-lynse.sh
./scripts/run-claude-lynse.sh
```

PowerShell:

```powershell
.\scripts\run-claude-lynse.ps1
```

O wrapper carrega `.env.lynse` antes de executar `claude`. Isso também configura o exportador OTLP/HTTP JSON para os endpoints da POC.

## 7. Execute a história de demonstração

Dentro do Claude Code:

```text
/lynse-start US-1842
```

O comando:

- cria a execução no Control Plane;
- associa a User Story, projeto, repositório, ABE e sessão Claude;
- salva apenas o `execution_id` ativo em `.claude/.lynse-state.json`;
- manda o agente ler a história, a SPEC e o repositório;
- exige um plano antes da primeira alteração.

Depois de revisar o plano:

```text
/lynse-approve plan Solução reutiliza os componentes existentes e cobre os seis critérios
```

Durante o trabalho:

```text
/lynse-status
```

Antes do PR e do deploy:

```text
/lynse-approve pr Evidências técnicas aprovadas
/lynse-approve deploy Homologação e rollback validados
```

Depois da observação pós-produção:

```text
/lynse-finish
```

## 8. Veja os dados no PostgreSQL

```bash
docker compose exec postgres psql -U lynse -d lynse_control_plane
```

Consultas úteis:

```sql
SELECT id, status, mode, started_at, ended_at
FROM executions
ORDER BY started_at DESC;

SELECT event_type, count(*)
FROM audit_events
GROUP BY event_type
ORDER BY event_type;

SELECT rule_code, decision, risk_level, count(*)
FROM policy_decisions
GROUP BY rule_code, decision, risk_level;

SELECT name, session_id, value, attributes
FROM otel_measurements
ORDER BY received_at DESC
LIMIT 30;
```

## 9. Teste o Policy Engine sem arriscar dados

Primeiro, mantenha `LYNSE_MODE=audit`, reinicie o Claude Code pelo wrapper e peça uma ação que contenha texto destrutivo, mas não destrua nada:

```text
Execute: echo "DROP TABLE customers"
```

A ação segue, mas `SEC-DB-04` é registrada como `would_block`.

Depois altere para:

```dotenv
LYNSE_MODE=enforcement
```

Reinicie o Claude Code e repita o mesmo `echo`. O `PreToolUse` devolve `deny` antes de Bash executar. O teste comprova a interceptação sem tocar no banco.

## 10. Leve a integração a outro repositório

Copie para a raiz do repositório-alvo:

- `.claude/settings.json`;
- `.claude/hooks/`;
- `.claude/skills/`;
- `CLAUDE.md`;
- `SPEC/`;
- `.env.lynse.example` e os wrappers de `scripts/`.

Então ajuste `LYNSE_PROJECT_SLUG`, `LYNSE_REPOSITORY_SLUG`, `LYNSE_ABE_EMAIL` e as SPECs. Cadastre o projeto/repositório no seed ou em uma API administrativa antes de começar.

## 11. Diagnóstico rápido

| Sintoma | Verificação |
|---|---|
| `/lynse-start` não aparece | confirme `.claude/skills/lynse-start/SKILL.md` e reabra a sessão |
| Hook não aparece em `/hooks` | valide o JSON de `.claude/settings.json` e `CLAUDE_PROJECT_DIR` |
| `401 API key inválida` | compare `.env` e `.env.lynse` |
| `Projeto ou repositório não encontrado` | use os slugs do seed ou cadastre os seus |
| Métricas ainda vazias | confirme variáveis `OTEL_*`; o exportador pode enviar em lote após alguns instantes |
| Política não bloqueia | confirme `LYNSE_MODE=enforcement` e reinicie o processo Claude |
| API indisponível não bloqueia | isso é esperado em `LYNSE_FAIL_MODE=open`; use `closed` apenas após estabilizar a plataforma |

## Referências oficiais

- [Claude Code — Hooks](https://code.claude.com/docs/en/hooks)
- [Claude Code — Skills](https://code.claude.com/docs/en/skills)
- [Claude Code — Monitoring usage](https://code.claude.com/docs/en/monitoring-usage)

