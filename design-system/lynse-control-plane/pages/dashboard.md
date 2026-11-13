# Dashboard Page Overrides

> **PROJECT:** Lynse Control Plane
> **Page Type:** Dashboard / Data View (operacional e executivo)

> Regras deste arquivo **sobrescrevem** o `MASTER.md`. Só os desvios estão documentados aqui.

---

## Decisões que sobrescrevem o MASTER

### Padrão de página
- **Ignorar "Enterprise Gateway"** (é padrão de landing page). Ordem da página:
  cabeçalho + filtros fixos → KPIs com variação vs. período anterior → tendência → exceções de
  política + deploys → consumo/custo → comparativo único (segmentado por ABE / projeto / organização).

### Cores (identidade Lynse, não a paleta azul gerada)
| Papel | Claro | Escuro |
|---|---|---|
| Primária / marca | `#d9650a` | `#f58a33` |
| Destaque | `#b7791f` (texto) / `#f5a524` (preenchimento) | `#f7b043` |
| Fundo | `#f5f4f2` | `#0e0e10` |
| Card | `#ffffff` | `#17171b` |
| Texto | `#1d1d20` | `#f4f4f5` |
| Texto secundário | `#55555c` | `#b5b5bd` |
| Sucesso / alerta / crítico | `#1f7a45` / `#9a6700` / `#c0392b` (texto) | `#2fb36a` / `#f7b043` / `#e5534b` |
- Texto sobre fundo sempre ≥ 4.5:1; marcas de dados ≥ 3:1.
- Nunca usar a cor como único sinal: variação tem seta + texto; outlier tem ícone + texto.

### Tipografia
- **Não usar Fira via Google Fonts**: o painel é aberto em redes de clientes que podem bloquear
  CDNs, e a fonte externa vaza IP para terceiros. Usar a pilha do sistema
  (`system-ui, "Segoe UI", Roboto, sans-serif`) e `font-variant-numeric: tabular-nums` em todo número.
- Corpo 14px (densidade alta), rótulos ≥ 12px. Nunca abaixo de 12px.

### Movimento
- **Sem GSAP** (dependência externa). Só transições CSS de 150–200ms em hover/foco.
- `prefers-reduced-motion: reduce` desliga todas as transições.

### Componentes
- **KPI**: valor grande, rótulo, variação vs. período anterior (seta + % + texto acessível) e
  base de comparação explícita ("vs. 30 dias anteriores").
- **Números**: formatação compacta pt-BR (1,7 bi; 12,4 mil), custo com 2 casas, nunca 4.
- **Médias**: usar mediana e p90, nunca média aritmética, para tempo e custo.
- **Outlier**: ≥ 2× a mediana do grupo; ícone SVG (não emoji) + texto no tooltip.
- **Tabelas**: ordenáveis com `aria-sort`, cabeçalho com `scope="col"`, números à direita.
- **Gráficos**: `aria-label` com o resumo do que o gráfico mostra; série diferenciada por cor
  **e** estilo de linha; eixo de tempo com granularidade explícita ("por dia").
- **Formulário de conexão**: label visível em cada campo (não só placeholder); botão com estado de carregando.
- **Estados**: skeleton enquanto carrega; estado vazio com mensagem e ação.
- **Foco**: anel de foco visível (2px, cor da marca) em todo elemento interativo.

---

## Recomendações mantidas do MASTER
- Estilo "Data-Dense Dashboard": grid, KPIs, tabelas, espaçamento compacto (escala 8–32px).
- Hover com destaque de linha, tooltips com valor exato, filtros sempre visíveis.
