# Filtra Dot — runbook de contenção em produção

> **Status: preparado, NÃO executado.** Este documento é o procedimento para
> desligar o Filtra Dot no serviço `filtra-ia-api` do Render. A execução exige
> autorização administrativa explícita e acesso ao painel/API do Render, que não
> estavam disponíveis nesta missão. Nenhuma variável de produção foi alterada.

## 1. Por que conter

A auditoria da DSV4 Missão 4 comprovou, por fingerprint público e análise do
código, que o build em produção corresponde ao **master `feac3cd`** e está com
**`FILTRA_DOT_ENABLED=1` e `FILTRA_DOT_FORCE_ON=1`**. O scheduler executa a cada
5 minutos e o worker está armado (`timer_active:true`), ainda que as rodadas
observadas tenham processado **zero empresas**.

Isso contraria a documentação de operação:

- `docs/DOT_PRODUCAO.md` §2: `FILTRA_DOT_FORCE_ON` — “Manter desligado até
  validar carga/idempotência/recuperação em produção”;
- `docs/DOT_RENDER_ACTIVATION_CHECKLIST.md`: ativação “preparada, **não
  aplicada**”;
- não há registro de aprovação humana ou de janela de ativação.

Enquanto a intenção não for confirmada pelo proprietário, o estado deve ser
tratado como **não aprovado** e a contenção é o caminho seguro.

## 2. Impacto da contenção

| Área | Efeito |
|---|---|
| Rotas `/api/dot/*` e `/api/dot/agent/*` | deixam de existir; `GET /api/dot/status` passa a responder **403** (tombstone) |
| Scheduler do monitor | não inicia (rodada imediata e timer param) |
| Worker de agente | não inicia; missões existentes ficam paradas em `planned`/`working` até reativação |
| Chat/explain autenticado | indisponível (403) |
| Frontend `/dot/conversa` | já responde 404 em produção; nada muda |
| Página `/dot` existente | perde as funções que dependem da API do Dot |
| Dados | **nada é apagado**; reservas, consumo, auditoria e missões permanecem |
| Clientes rei/corporativo | perdem o recurso durante a contenção (comunicar, se aplicável) |

Não há risco de cobrança por desligar as flags. Requisições HTTP em voo no
momento do restart podem falhar; o ledger/idempotência do PR #144 ainda **não**
está no build implantado, então o restart pode interromper uma conversa em
andamento (sem efeito em background, que não chama provedor).

## 3. Pré-requisitos (checklist antes de tocar em produção)

- [ ] Autorização explícita do proprietário/serviço, com janela e responsável.
- [ ] Confirmar no Render: branch implantada, `autoDeploy` e deploy history
      (inclusive se a ativação foi intencional e desde quando).
- [ ] Confirmar que `FILTRA_DOT_ENABLED` e `FILTRA_DOT_FORCE_ON` são as únicas
      variáveis a remover — **não** tocar em `DATABASE_URL`, `JWT_SECRET`,
      `CORS_ORIGINS`, chaves de IA, `METRICS_TOKEN`/`JOBS_SECRET`.
- [ ] Backup/PITR do Supabase confirmado e janela aprovada (defensivo).
- [ ] Canal de suporte/comunicação ciente (se houver clientes usando o `/dot`).

## 4. Procedimento exato (Render, painel)

1. Render Dashboard → serviço **`filtra-ia-api`**
   (`srv-dafc88ad0e5s73bqgfm0`) → aba **Environment**.
2. Localizar e **remover** (ou desmarcar) exatamente:
   - `FILTRA_DOT_ENABLED`
   - `FILTRA_DOT_FORCE_ON`
   > Remover `FILTRA_DOT_ENABLED` já basta para o boot não montar rotas nem
   > iniciar timers; remover também `FILTRA_DOT_FORCE_ON` evita ambiguidade e
   > reativação acidental do monitor.
3. Salvar. O Render aplica a mudança reiniciando o serviço (novo processo com a
   mesma imagem, salvo se houver deploy pendente — conferir o evento gerado).
4. Acompanhar o evento até o serviço ficar **live** e aguardar o cold start
   (pode levar ~1–2 min).
5. Validar com a ferramenta somente leitura:

```bash
cd backend
DOT_CHECK_BASE_URL=https://filtra-ia-api.onrender.com \
  node --import tsx scripts/dot-containment-check.ts --expect disabled
```

Saída esperada (exit 0):

```json
{
  "expect": "disabled",
  "ok": true,
  "summary": {
    "live_status": 200,
    "health_status": 200,
    "dot_status_status": 403,
    "dot_status_enabled": false,
    "scheduler_timer_active": null,
    "worker_timer_active": null,
    "preferences_status": 404
  },
  "problems": []
}
```

6. Confirmar no log do serviço a linha:
   `[dot] Filtra Dot desativado (defina FILTRA_DOT_ENABLED=1 para habilitar).`
7. Registrar no ticket: operador, data/hora, janela, saída do script, link do
   evento de deploy/restart e capturas de tela (sem valores de segredos).

## 5. Critérios de validação (evidências esperadas)

| Verificação | Esperado pós-contenção |
|---|---|
| `GET /api/live` | 200, `started_at` novo (processo reiniciado) |
| `GET /api/health` | 200, `db_ok:true` |
| `GET /api/dot/status` | **403**, `enabled:false`, sem `scheduler`/`worker` no corpo |
| `GET /api/dot/preferences` (sem token) | **404** (rota não montada) |
| Script `--expect disabled` | `ok:true`, exit 0 |
| Log do serviço | `[dot] Filtra Dot desativado ...` |
| Observação de 10–15 min | nenhuma linha `[dot-scheduler]`/`DOT agente` nova |

Se o serviço hibernar por inatividade (comportamento observado), o log de boot
aparece somente no próximo cold start; nesse caso valide pelo script e pelo
`started_at` após acordar.

## 6. Rollback (reativação)

Somente com nova autorização:

1. recriar `FILTRA_DOT_ENABLED=1` (rotas + worker);
2. recriar `FILTRA_DOT_FORCE_ON=1` **apenas** se o monitor agendado for
   intencional;
3. salvar/reiniciar; validar com
   `dot-containment-check.ts --expect enabled` (status 200, `timer_active:true`
   para scheduler e worker);
4. confirmar `[dot] Filtra Dot habilitado` e `Filtra Dot monitor ativo` no log.

> Reativar sem o ledger durável do PR #144 mantém o risco financeiro de retry/
> concorrência descrito em `DOT_FINANCIAL_CONTROLS.md`.

## 7. O que NÃO fazer

- Não alterar código, branch ou `autoDeploy` para “resolver” a contenção.
- Não desativar branch protection, checks obrigatórios ou a integração de
  auditoria.
- Não apagar dados, tabelas, reservas ou logs.
- Não marcar este runbook como executado sem as evidências da seção 5.
- Não usar `FILTRA_DOT_ENABLED=0` como substituto de remoção (o código compara
  com `'1'`, então `0` equivale a ausente, mas a remoção evita ambiguidade).

## 8. Situação

- Runbook: preparado.
- Execução: **não autorizada / não executada** nesta missão.
- Ferramenta de verificação: `scripts/dot-containment-check.ts` +
  `lib/dotContainmentCheck.ts` (6 testes, somente leitura).
