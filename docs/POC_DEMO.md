# Roteiro da demonstração

Tempo sugerido: 15 a 20 minutos.

## 1. Mostre o objetivo

Abra `docs/ARCHITECTURE.md` e explique a correlação: a User Story ganha um `execution_id`; a sessão do Claude liga hooks e OTLP à execução.

## 2. Suba a infraestrutura

```bash
docker compose up --build -d
curl http://localhost:3333/health
```

## 3. Abra a história

Inicie pelo wrapper e execute:

```text
/lynse-start US-1842
```

Destaque que o ABE realizou uma ação, enquanto o sistema criou execução, vínculo da sessão e trilha de auditoria.

## 4. Demonstre o gate de plano

Peça ao agente para explicar solução, arquivos, riscos e testes. Registre:

```text
/lynse-approve plan Critérios, segurança e testes cobertos
```

## 5. Demonstre audit e enforcement

Em `audit`, peça `echo "DROP TABLE customers"` e mostre `would_block` no banco. Depois reinicie em `enforcement`, repita e mostre o bloqueio antes do Bash.

## 6. Mostre a telemetria

Execute algumas leituras e testes, aguarde o próximo lote OTLP e use:

```text
/lynse-status
```

Abra as tabelas `audit_events`, `policy_decisions` e `otel_measurements` para provar a correlação pelo `session.id`.

## 7. Simule PR e deploy

Use os exemplos da API para registrar um PR e um deploy em HML/PROD. Registre gates `pr` e `deploy`. Termine com `/lynse-finish` e exiba o resumo final.

## Critérios de sucesso da POC

- uma execução nasce a partir de `US-1842`;
- eventos do Claude Code aparecem associados à execução;
- uma política é observada em `audit` e bloqueada em `enforcement`;
- tokens/métricas recebidos por OTLP aparecem associados à sessão;
- aprovações, PR e deploy integram o mesmo histórico;
- `/lynse-status` apresenta uma única visão consolidada.

