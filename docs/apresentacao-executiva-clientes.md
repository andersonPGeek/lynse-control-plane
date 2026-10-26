# Roteiro para apresentação executiva — Operação Lynse

Este arquivo reúne tudo que você precisa para montar a apresentação para clientes sobre
governança, segurança e escala de times com IA generativa. Tem três partes:

1. **Roteiro de slides** — estrutura sugerida, pronta para virar apresentação.
2. **Conteúdo de apoio** — a explicação completa e correta de cada mecanismo, pra você usar
   no texto dos slides e responder perguntas na hora.
3. **Perguntas que clientes costumam fazer** — antecipadas, com resposta pronta.

O objetivo da apresentação é deixar claro, sem entrar em detalhe técnico excessivo, que: você
tem visibilidade completa do que os desenvolvedores fazem com IA no código do cliente, tem
controles automáticos de segurança, e consegue crescer o time sem perder controle de qualidade
— porque todo o processo é auditado em tempo real, não por confiança.

---

## Parte 1 — Roteiro de slides (sugestão de 13 telas)

### 1. Capa
"Governança de engenharia com IA — como garantimos segurança, rastreabilidade e qualidade em
escala." Nome do cliente, data.

### 2. O contexto
IA generativa acelera desenvolvimento, mas levanta uma pergunta legítima de todo cliente: *"se
seu time usa IA no meu código, quem garante que isso é seguro e controlado?"* Esta apresentação
responde essa pergunta com o processo, não com uma promessa.

### 3. O que é a Operação Lynse
Um framework de governança que acompanha cada tarefa que um desenvolvedor faz com o Claude Code
(assistente de IA), do início ao fim — com um humano responsável (o **ABE**, AI Build Engineer)
tomando toda decisão relevante, e um sistema (o **Control Plane**) registrando tudo de forma
independente do desenvolvedor.

### 4. O fluxo, do início ao fim de uma tarefa
Diagrama simples: `abrir tarefa → planejar → aprovação do plano → implementar → aprovação do PR
→ aprovação de deploy → deploy → validação em produção → encerrar tarefa`. Cada seta é um ponto
de controle, não uma formalidade — sem aprovação, a tarefa não avança de fase no sistema.

### 5. Comandos simples, atrito zero
Quatro comandos que o desenvolvedor usa, nada mais (detalhe na Parte 2). Passar rápido aqui —
o ponto é "é simples de usar", não ensinar sintaxe.

### 6. Rastreabilidade total
Toda ação fica automaticamente ligada a: **quem** fez (o desenvolvedor), **onde** (projeto e
repositório), **para qual cliente/organização**, e **qual tarefa** (a User Story). Isso não é
preenchido manualmente — é detectado automaticamente.

### 7. Controles automáticos de segurança (Policy Engine)
Antes de qualquer ação de risco (mexer em segredo, banco, produção, histórico do Git), um motor
de políticas analisa e decide: permite, pede confirmação, ou bloqueia — antes da ação acontecer,
não depois.

### 8. Dois modos: observar e agir
Times novos começam em modo observação (tudo é registrado, nada é travado) até o processo
amadurecer, depois migram para modo ativo (bloqueio automático de ações de risco). Mostra que o
rollout é gradual e sob controle do cliente/ABE.

### 9. Consumo e custo em tempo real
Quantos tokens e quanto custo cada tarefa, projeto, desenvolvedor e cliente gerou — vem direto
da telemetria nativa da ferramenta de IA, sem estimativa manual.

### 10. Nem toda tarefa iniciada termina — e isso é visível
Diferença entre execuções iniciadas e concluídas. Mostra maturidade: o processo não esconde
trabalho abandonado, bloqueado ou em andamento — ele reporta a real taxa de conclusão.

### 11. Deploy por ambiente, rastreado
Todo deploy (homologação, produção) fica registrado com resultado — sucesso, falha, rollback.
Encerrar uma tarefa exige, entre outras evidências, um deploy de produção bem-sucedido
registrado.

### 12. Dashboard — visão executiva ao vivo
Print de tela (ou demo ao vivo) do dashboard: indicadores por ABE, projeto e organização,
comparação com a média do grupo (sinaliza quem está fora do padrão), decisões de política,
consumo/custo. *Esse é o slide mais forte da apresentação — considere fazer ao vivo.*

### 13. O código-fonte do cliente nunca sai daqui
O slide de segurança. Detalhe completo na Parte 2, seção "Segurança dos dados do cliente" — é o
ponto que mais importa para quem está decidindo confiar ou não.

### 14. Fechamento
"Você ganha velocidade de um time com IA, sem abrir mão de controle — porque cada ação é
observável, cada risco é filtrado antes de acontecer, e cada resultado é auditável."

---

## Parte 2 — Conteúdo de apoio (explicação completa de cada ponto)

### Os comandos que o desenvolvedor usa

Só quatro, e o processo pausa sozinho nos pontos certos:

| Comando | Quando usar | O que acontece |
|---|---|---|
| `/lynse-start <ID da User Story>` | Antes de tocar em qualquer código | Abre um registro da tarefa no Control Plane, vinculado ao desenvolvedor, projeto e organização. A partir daqui, tudo que o desenvolvedor pedir à IA fica associado a essa tarefa. |
| `/lynse-approve plan <justificativa>` | Depois de revisar o plano que a IA propôs, antes de qualquer mudança de código | Só depois dessa aprovação a IA tem autorização para começar a implementar. |
| `/lynse-approve pr <justificativa>` | Antes de abrir o Pull Request | Registra que as evidências técnicas (testes, revisão) foram aprovadas. |
| `/lynse-approve deploy <justificativa>` | Antes de subir para produção | Registra que a homologação e o plano de rollback foram validados. |
| `/lynse-status` | A qualquer momento | Mostra o estado atual da tarefa — não altera nada. |
| `/lynse-finish` | Depois do deploy em produção e da validação pós-deploy | Encerra a tarefa. **Só funciona se todas as aprovações acima e um deploy de produção bem-sucedido estiverem registrados** — o sistema recusa encerrar uma tarefa sem essas evidências. |

Para o cliente: o ponto-chave é que a IA **não pode avançar sozinha** — cada fase crítica exige
uma decisão humana explícita e registrada, e o encerramento da tarefa é bloqueado pelo próprio
sistema até que as evidências existam.

### Como capturamos ABE, projeto, organização e User Story em cada prompt

Cada desenvolvedor tem uma **chave de identificação pessoal** — não uma chave compartilhada da
equipe. Isso significa que toda ação registrada já nasce vinculada a uma pessoa específica, sem
depender de autodeclaração.

Quando o desenvolvedor roda `/lynse-start`, o sistema:
1. Identifica automaticamente o repositório e o projeto a partir do controle de versão (Git) do
   diretório aberto — o desenvolvedor não digita nome de projeto.
2. Associa isso à organização (cliente) dona daquela chave pessoal.
3. Vincula à User Story informada no comando.

A partir daí, **todo prompt e toda ação de ferramenta** (editar arquivo, rodar comando) dentro
daquela sessão do assistente de IA é automaticamente etiquetada com esse mesmo vínculo
(desenvolvedor + projeto + organização + tarefa) — o desenvolvedor não faz nada manualmente para
isso acontecer.

### Como funciona o início e o fim de uma sessão

Existem dois conceitos que andam juntos mas não são a mesma coisa:

- **Sessão do assistente de IA**: começa quando o desenvolvedor abre o Claude Code e termina
  quando ele fecha. Marcada automaticamente por eventos de "sessão iniciada" e "sessão
  encerrada" que o próprio assistente emite.
- **Execução (a tarefa/User Story)**: começa no `/lynse-start` e só termina no `/lynse-finish` —
  pode durar mais que uma sessão (o desenvolvedor pode fechar e reabrir o Claude Code no meio de
  uma tarefa) ou uma sessão pode conter mais de uma tarefa em sequência.

O que importa para o cliente: a tarefa tem início e fim formais, controlados por aprovação — não
é "a IA trabalhou por aí", é um processo com abertura e fechamento registrados e auditáveis.

### Como sabemos o consumo de tokens

O próprio assistente de IA (Claude Code) emite, nativamente, uma métrica de consumo de tokens
para cada sessão — dividida em tokens de entrada, saída, e tokens reaproveitados de cache
(otimização que reduz custo). O Control Plane recebe essa métrica diretamente da ferramenta,
**não é uma estimativa** — é o dado real emitido pelo provedor de IA, correlacionado à tarefa
através da sessão.

### Como chegamos no custo

O mesmo mecanismo: o assistente de IA emite, nativamente, o custo em dólar de cada sessão,
calculado pelo próprio provedor de acordo com o modelo usado. O Control Plane só recebe e
organiza esse valor por desenvolvedor, projeto, organização e tarefa — **não fazemos conta
manual com tabela de preço**, o número já vem calculado na fonte.

### Por que o cliente não precisa se preocupar com a segurança do código-fonte dele

Este é o ponto mais importante da conversa com o cliente. A resposta é uma arquitetura, não uma
promessa: **a análise de risco acontece dentro da máquina do desenvolvedor, e o servidor só
recebe metadados.**

**1. A política de segurança é decidida localmente.**
Quando o desenvolvedor pede algo ao assistente, as regras de segurança (segredos, comandos
destrutivos, produção, histórico do Git) são avaliadas **na própria máquina dele**. O texto do
prompt, o comando e o conteúdo dos arquivos **não são enviados** ao Control Plane. O servidor
recebe apenas o resultado: qual regra disparou, o nível de risco, o modo (observação ou bloqueio)
e uma impressão digital (hash) irreversível do texto, usada só para correlação.

**2. O que o Control Plane recebe e guarda, por evento.**
Tipo do evento (ex.: "antes de usar uma ferramenta"), nome da ferramenta, horário, hash e tamanho
do texto, categorias de risco detectadas e, quando há alteração de arquivos, apenas contagens
("3 arquivos, 42 linhas adicionadas, 5 removidas"). Também recebe a identidade do desenvolvedor, a
User Story, o nome do repositório, a branch e o SHA do commit.

**3. O que nunca sai da máquina do desenvolvedor.**
Texto de prompts, comandos, caminhos e conteúdo de arquivos, diffs, saída de consultas e de
ferramentas, caminho da pasta do projeto e a URL do repositório (só um hash dela). Isso vale no
modo padrão (`metadata`). Antes de existir uma execução ativa (`/lynse-start`) ou depois dela
(`/lynse-finish`), nada é enviado.

**4. Modos opcionais, só com autorização do cliente.**
O modo `classified` acrescenta uma prévia de 240 caracteres do prompt e da entrada da ferramenta,
já com segredos removidos; o modo `full` guarda mais contexto. Nenhum dos dois é o padrão e a
saída das ferramentas nunca leva prévia, a menos que o modo `full` seja habilitado de propósito.
Atenção: a remoção automática cobre credenciais (chave privada, chave de nuvem, token, senha), mas
**não** reconhece dado de negócio ou dado pessoal — por isso o padrão não guarda texto nenhum.

**5. O próprio mecanismo não toca no repositório do cliente.**
A configuração fica na máquina do desenvolvedor, fora do repositório (ver seção de setup abaixo):
nenhum arquivo, dependência ou alteração é introduzido no código do cliente.

### Como capturamos os eventos

O assistente de IA (Claude Code) tem um sistema nativo de "pontos de observação" — a cada etapa
relevante (sessão iniciando, prompt enviado, antes de usar uma ferramenta, depois de usar uma
ferramenta, uma ferramenta falhou, sessão encerrando, entre outros), ele avisa automaticamente
um observador registrado. O Control Plane é esse observador: recebe cada evento, junto com a
identidade do desenvolvedor e da tarefa ativa, e grava. O desenvolvedor não aciona isso
manualmente — é automático e não pode ser contornado pela IA.

### A diferença entre execuções iniciadas e concluídas

Nem toda tarefa aberta chega ao fim — e isso é esperado e saudável: um desenvolvedor pode
começar, descobrir que o escopo mudou, e abandonar; uma tarefa pode ficar bloqueada por uma
decisão de segurança; outra pode simplesmente ainda estar em andamento. O painel mostra os
quatro estados lado a lado: **iniciadas** (total), **concluídas**, **bloqueadas**, **em
andamento** — de propósito, para que a taxa real de conclusão fique visível, em vez de mostrar
só "tudo que foi feito" e esconder o que não chegou ao fim.

### Como pegamos o deploy por ambiente

Cada deploy (para homologação ou produção) é registrado explicitamente, com o resultado: teve
sucesso, falhou, ou foi revertido. Um deploy de produção bem-sucedido é uma das evidências
obrigatórias para encerrar a tarefa — sem ele, o sistema recusa o `/lynse-finish`. O painel
agrega esses registros por ambiente, então dá pra ver, por projeto, quantos deploys aconteceram
em cada ambiente e com que resultado.

### O dashboard de monitoramento

Existe um painel visual, atualizado em tempo real, com:
- Números gerais: execuções totais, concluídas, bloqueadas, em andamento, tempo médio, User
  Stories concluídas, custo total.
- **Linha de base**: a média de cada indicador (tempo, tokens, custo, deploys) — para comparar
  cada desenvolvedor/projeto contra o normal do grupo.
- Decisões da política de segurança (quantas ações foram permitidas, pediram confirmação, ou
  foram bloqueadas).
- Consumo de tokens e custo por desenvolvedor, projeto, organização e User Story.
- Deploys por ambiente e eventos por tipo.
- Tabelas por organização, projeto e desenvolvedor, com sinalização automática (⚠) de quem está
  significativamente fora da média do grupo.

Esse painel pode ser mostrado ao vivo na apresentação — é a prova visual de tudo que os slides
anteriores descreveram.

### Como funciona o setup na máquina de cada desenvolvedor

Ponto importante para deixar claro ao cliente: **a instalação não tem nenhuma relação com o
código do cliente.**

Tudo que habilita esse processo — os comandos, os gatilhos de captura de eventos, a
identificação de projeto — é instalado uma única vez na pasta pessoal de configuração do
desenvolvedor (fora de qualquer repositório), não dentro do projeto. Isso quer dizer:

- Nenhum arquivo novo aparece no repositório do cliente.
- Nada é commitado, versionado ou fica visível no controle de versão do cliente.
- O desenvolvedor pode abrir qualquer repositório de qualquer cliente na mesma máquina, e o
  processo de governança funciona igual em todos, sem precisar configurar nada específico por
  projeto.
- Se o vínculo do desenvolvedor com o cliente terminar, remover a chave pessoal dele encerra o
  acesso — sem precisar tocar em nenhum repositório.

Cada desenvolvedor recebe uma chave de acesso pessoal (não compartilhada), o que também garante
que toda ação registrada é atribuível a uma pessoa específica.

---

## Parte 3 — Perguntas que clientes costumam fazer

**"Vocês guardam meu código-fonte?"**
Não. A análise de risco roda na máquina do desenvolvedor e o servidor só recebe metadados das
ações (o quê, quando, por quem, qual o risco, um hash do texto) e contagens de mudança — nem o
código, nem prompts, nem comandos, nem caminhos de arquivo saem da máquina no modo padrão. Ver a
seção de segurança acima para o detalhe exato.

**"E se um desenvolvedor tentar burlar isso?"**
Os pontos de observação são nativos da ferramenta de IA e disparam automaticamente — não passam
por uma ação manual do desenvolvedor que ele possa pular. E encerrar uma tarefa sem as
aprovações e o deploy registrado é recusado pelo próprio sistema.

**"Isso desacelera o time?"**
O fluxo de aprovação acontece nos mesmos pontos em que qualquer processo de revisão sério já
pausaria (plano, PR, deploy) — a diferença é que fica registrado, não que adiciona etapas novas.
Além disso, o sistema pode rodar em modo observação primeiro, sem bloquear nada, até o time se
acostumar.

**"Onde ficam esses dados?"**
Hoje o Control Plane roda no Render, um provedor de nuvem de terceiros. Como o servidor recebe só
metadados (sem texto de prompt, código ou dado do cliente), o risco é baixo, mas ainda é um
subcontratado. [Antes de apresentar, confirme a região do servidor e se o contrato do cliente exige
cláusula ou autorização para subcontratados; se exigir, a alternativa é hospedar o Control Plane
na infraestrutura aprovada por ele.]

**"Isso vale só para este projeto ou para todos os clientes que vocês atendem?"**
O mecanismo é o mesmo em qualquer repositório que o desenvolvedor abrir — permite dar a mesma
garantia de governança para todos os clientes atendidos, não só para um.

**"Como sei que os números do dashboard são reais e não editáveis pelo desenvolvedor?"**
O registro acontece automaticamente pelos pontos de observação nativos da ferramenta, não por
autodeclaração do desenvolvedor — ele não preenche formulário nem digita o que foi feito.

---

## Notas internas (não usar nos slides — só para você se preparar)

- O consumo de tokens/custo é atribuído à tarefa mais recente de cada sessão. Se uma sessão
  cobrir mais de uma User Story sem reiniciar o Claude Code, o consumo todo fica na última —
  aproximação hoje, vale mencionar só se um cliente perguntar o detalhe técnico.
- A telemetria de tokens/custo só existe se o desenvolvedor tiver habilitado as variáveis de
  telemetria no ambiente dele — não é automático hoje. Se for demonstrar ao vivo, confirme que a
  máquina usada tem isso ligado.
- A separação entre clientes hoje é por filtro no dashboard (projeto/organização), não por
  infraestrutura fisicamente isolada por cliente — não prometa isolamento de infraestrutura sem
  confirmar que isso é o que o cliente está perguntando.
- A decisão de política roda na máquina do desenvolvedor. Isso protege o dado, mas significa que a
  integridade do registro depende de o kit local não ser adulterado — hoje não há prova
  criptográfica de que o hook não foi modificado. Não afirme "impossível burlar"; diga que o
  registro é automático e atribuído a uma pessoa.
- Ainda saem para o servidor: nome do repositório (ou o apelido de LYNSE_PROJECT_SLUG), nome da
  branch e SHA do commit. Se o nome do repositório ou da branch for sensível para o cliente, use o
  apelido.
- Instalações antigas do kit (anteriores a esta versão) ainda enviam o texto bruto do prompt para
  avaliação no servidor. Só afirme o que está neste documento sobre desenvolvedores que
  atualizaram o kit.
- A remoção automática de segredos não cobre dado pessoal nem dado de negócio (CPF, nome, valores
  de nota fiscal). É por isso que o padrão é não guardar texto algum.
- O modo "enforcement" (bloqueio ativo) precisa ser configurado explicitamente — o padrão é
  modo observação. Confirme em qual modo o time do cliente está antes de afirmar "bloqueamos
  automaticamente".
