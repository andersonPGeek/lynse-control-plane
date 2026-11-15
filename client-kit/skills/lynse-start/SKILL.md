---
name: lynse-start
description: Inicia ou retoma a execução da Operação Lynse para uma User Story. Use assim que o ABE disser em qual User Story (ou tarefa) vai trabalhar, ou quando ele responder o ID que você perguntou. Nunca invente o ID.
argument-hint: <US-ID>
---

## Execução no Control Plane

!`node "${CLAUDE_SKILL_DIR}/../../hooks/lynse-cli.mjs" start "$0" "${CLAUDE_SESSION_ID}"`

Leia a resposta acima e, em no máximo duas linhas, informe o ABE:
- `reused: true` → a execução **já existia e foi retomada**: diga desde quando está aberta e a etapa atual, e continue de onde parou, sem refazer etapas aprovadas.
- `previous_marked_inconsistent` → siga o `agent_instruction`: avise que a US anterior ficou registrada como inconsistente e pergunte, uma vez, se ela já foi concluída. Se ele confirmar, rode `/lynse-finish <id da execução anterior>`. Se não, siga normalmente.
- `reopened: true` → a US já tinha sido concluída antes; avise que esta execução conta como reabertura.
- Se o comando falhou, diga isso em uma linha e **continue atendendo o ABE normalmente**. Nada no processo pode atrapalhar o trabalho.

Se for uma US nova (`reused: false`), você está na etapa **Entender e planejar**:
1. Leia a User Story e os arquivos aplicáveis em `SPEC/`, se existirem.
2. Explore o repositório e identifique o que deve ser reutilizado.
3. Relacione cada critério de aceite a uma mudança e a uma evidência de teste.
4. Apresente um plano curto (solução, arquivos prováveis, riscos, testes e dúvidas) e pergunte se o ABE aprova.
5. Quando ele aprovar, termine a resposta com `[lynse: aprovado plan]` e implemente.
