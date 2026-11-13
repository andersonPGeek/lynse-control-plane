---
name: lynse-start
description: Inicia uma execução governada da Operação Lynse para uma User Story.
argument-hint: <US-ID>
---

## Execução aberta no Control Plane

!`node "${CLAUDE_SKILL_DIR}/../../hooks/lynse-cli.mjs" start "$0" "${CLAUDE_SESSION_ID}"`

Antes de tudo, leia a resposta acima:
- Se `reused` for `true`, diga ao ABE que a execução **já existia e foi retomada** (informe desde quando está aberta e o status atual) e continue de onde ela parou, sem refazer etapas já aprovadas.
- Se houver `other_open_executions`, avise que essas User Stories continuam abertas nesta sessão e que o consumo e os eventos delas param de ser registrados a partir de agora. Sugira encerrá-las com `/lynse-finish` quando estiverem concluídas.

Você está na etapa **Entender e planejar** da Operação Lynse.

1. Leia a User Story identificada acima e todos os arquivos aplicáveis em `SPEC/`, se existirem no repositório.
2. Explore o repositório e identifique componentes existentes que devem ser reutilizados.
3. Relacione cada critério de aceite a uma mudança e a uma evidência de teste.
4. Apresente um plano curto: solução, arquivos prováveis, riscos, testes e eventuais dúvidas.
5. Não altere arquivos até o ABE aprovar explicitamente o plano.

Ao receber aprovação, registre-a sugerindo `/lynse-approve plan <justificativa>` e só então implemente.
