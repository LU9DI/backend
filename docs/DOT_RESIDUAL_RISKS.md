# Filtra Dot — riscos técnicos residuais

> Análise da DSV4 Missão 3 (2026-11-11) sobre o HEAD do backend
> `5fb46bd4` (código `de722b5a`) e do frontend `c9510330`. Severidade considera
> o cenário de produção descrito no plano de ativação (empresa piloto, Render
> com banco Supabase, Dot inicialmente desligado).

## Resumo

| # | Risco | Severidade | Impacto principal | Corrigir antes da produção? |
|---|---|---|---|---|
| R1 | Histórico de conversa em memória por processo | **média** | contexto inconsistente entre instâncias/reinícios; memória cresce sem TTL | condicional (bloqueante se houver > 1 instância) |
| R2 | Contadores/métricas por processo zeram no deploy | **baixa** | dashboards e alertas sem continuidade | não (operacional) |
| R3 | `/api/dot/explain` sem idempotência HTTP | **média** | retry pode gerar nova reserva e nova chamada ao provedor | condicional (bloqueante se exposto a cliente com retry) |
| R4 | Service worker cacheia APIs por URL | **baixa/média** | dados antigos de painel/assinatura offline; não afeta o Dot | não (fora do escopo do Dot) |
| R5 | Consistência financeira em crash/reinício | **alta** | reserva ambígua exige reconciliação manual; orçamento temporariamente preso | sim, com runbook + alertas antes de ligar o Dot |
| R6 | Build de produção atual difere do PR | **alta para ativação** | scheduler/worker já ativos no build antigo; `/api/dot/status` público 200 | sim (confirmar branch/autoDeploy e deploy controlado) |

## R1 — Histórico de conversa em memória por processo

**Evidência:** `routes/dotRoutes.ts` mantém `const sessions = new Map<string,
ChatItem[]>()`; cada sessão guarda no máximo 12 mensagens (`MAX_HISTORY`), mas o
número de sessões não tem TTL/LRU e não há armazenamento compartilhado. A chave
inclui empresa/usuário (`scopedSessionId`), então não há vazamento entre
tenants; o frontend mantém sua própria cópia em `localStorage` por escopo.

**Impacto:** com duas ou mais instâncias no Render, a mesma conversa pode
alternar entre processos e perder contexto; após deploy o contexto em memória
some (o histórico visível do cliente permanece). Em processo muito longo, o mapa
de sessões cresce sem limite.

**Recomendação:** para o piloto, manter **uma instância** e avisar que o
contexto do servidor é efêmero; antes de escalar, mover para tabela/Redis com
TTL e limitar o mapa por LRU. Não é bloqueante para produção com uma instância.

## R2 — Contadores locais zeram no deploy

**Evidência:** `lib/metrics.ts` mantém contadores e janela de latência em
memória; `/api/metrics` expõe o estado do processo.

**Impacto:** séries reiniciam a cada deploy/restart; alertas de delta ficam em
aquecimento (o coletor detecta reinício e não dispara falso positivo) e o
histórico só existe se houver scraper externo.

**Recomendação:** operacional — ativar o coletor em daemon (`ops/alerts/`) e/ou
scraper externo, e aceitar que séries históricas são responsabilidade da
plataforma. Sem correção de código.

## R3 — `/api/dot/explain` sem idempotência HTTP

**Evidência:** apenas `/api/dot/chat` chama `claimDotHttpRequest`; `explain`
cria reserva e chama o provedor sem chave de idempotência.

**Impacto:** um retry do cliente (ou duplo clique) pode gerar duas reservas e
duas chamadas ao provedor para a mesma explicação — cobrança dupla real. O
ledger impede consumo duplicado da **mesma** reserva, mas não deduplica
requisições distintas. O frontend de conversa não usa `explain`.

**Recomendação:** antes de expor o endpoint a clientes com retry, aplicar o
mesmo contrato de chave do chat (recomendado) ou documentar formalmente que o
cliente não deve repetir. Bloqueante se houver consumo externo; não bloqueante
para o piloto da conversa.

## R4 — Service worker e cache de APIs

**Evidência:** `frontend/public/sw.js` — network-first para navegação, allowlist
de GETs cacheados (`/api/empresa/:id/painel`, `validar`, `assinatura`,
`/api/health`, `/api/metrics`, etc.), fallback offline. `/api/dot/*` **não**
está na allowlist: status é pass-through e POST do chat não é interceptado. O SW
também impede `page.route` de interceptar fetches após reload — por isso o spec
do Dot bloqueia o SW apenas nele.

**Impacto:** o Dot não é cacheado (bom). O risco está fora do Dot: respostas de
painel/assinatura ficam em cache por URL e podem ser servidas offline em um
dispositivo compartilhado; logout não limpa o cache.

**Recomendação:** fora do escopo desta missão; avaliar limpeza de cache no
logout/troca de tenant e remover APIs sensíveis da allowlist. Não bloqueia o Dot.

## R5 — Consistência financeira em falhas e reinícios

**Evidência e mitigações existentes:**

- reserva durável com `sent_at`; liquidação insere `ai_usage` **na mesma
  transação** (`finalizeDotReservation`), com `FOR UPDATE` e lock por empresa;
- liberação só com prova de não envio; resultado ambíguo **nunca** é liberado
  pelo relógio (`ambiguous=1`) e exige reconciliação;
- `dot_http_idempotency` durável com lease de 15 min: `processing` vencido vira
  `ambiguous` e não é retomado automaticamente; `failed_safe` só volta a
  processar com prova registrada;
- sweep de reservas vencidas é **preguiçoso por tenant** (no próximo
  `reserve`/snapshot), não global no boot;
- shutdown gracioso drena worker/scheduler (`stopDotAgentWorkerAndDrain`,
  `stopDotMonitorScheduler`).

**Impacto residual:** após crash entre envio ao provedor e liquidação, a reserva
fica ambígua e o orçamento comprometido até intervenção manual; a chamada já
pode ter sido cobrada pelo provedor. Não há reconciliação automática nem alerta
ativo hoje.

**Recomendação (bloqueante antes de ligar o Dot):**

1. canal de alerta ativo para A2 (ambíguos) e A3 (falha de liquidação);
2. operador treinado no procedimento de `DOT_PRODUCTION_READINESS.md` §2.5;
3. janela de observação com volume baixo (empresa piloto);
4. aceitar formalmente que reservas ambíguas exigem ação humana.

## R6 — Build de produção atual difere do PR (achado da inspeção Render)

**Evidência pública (somente leitura):** `/api/health` de produção **não** tem o
bloco `dot` adicionado pelo PR; `/api/dot/status` responde 200 (o PR responde
403/503 quando desligado); scheduler e worker aparecem com `timer_active:true`
mesmo com `enabled:false`; processo reiniciado em `2026-11-11T20:34:05Z`.

**Impacto:** o comportamento validado no PR não é o que está no ar. Antes de
ativar, é obrigatório confirmar branch/`autoDeploy` no Render e implantar
explicitamente o commit aprovado; caso contrário, o “desligado” do PR (rotas
inexistentes, timers parados) não vale em produção. A causa do restart de
20:34Z não pôde ser atribuída sem o histórico de deploys.

**Recomendação:** bloqueante — confirmar deploy history, branch e `autoDeploy`;
fazer o primeiro deploy com as flags do Dot ausentes e validar
`/api/dot/status` = 403/404 e `/api/health.dot` presente.

## Itens avaliados e considerados aceitáveis

- Rate limit e CSRF do chat: cobertos por código e E2E.
- Redação de logs: testada (nenhum conteúdo/credencial).
- Migrações: idempotentes e fail-closed; compatibilidade com produção depende da
  leitura do Supabase (pendente).
- Frontend: E2E 19/19 e build estático verde; sem risco aberto específico.
