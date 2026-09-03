---
name: lynse-start
description: Inicia uma execução governada da Operação Lynse para uma User Story.
argument-hint: <US-ID>
---

## Execução aberta no Control Plane

!`node "${CLAUDE_SKILL_DIR}/../../hooks/lynse-cli.mjs" start "$0" "${CLAUDE_SESSION_ID}"`

Você está na etapa **Entender e planejar** da Operação Lynse.

1. Leia a User Story identificada acima e todos os arquivos aplicáveis em `SPEC/`, se existirem no repositório.
2. Explore o repositório e identifique componentes existentes que devem ser reutilizados.
3. Relacione cada critério de aceite a uma mudança e a uma evidência de teste.
4. Apresente um plano curto: solução, arquivos prováveis, riscos, testes e eventuais dúvidas.
5. Não altere arquivos até o ABE aprovar explicitamente o plano.

Ao receber aprovação, registre-a sugerindo `/lynse-approve plan <justificativa>` e só então implemente.
