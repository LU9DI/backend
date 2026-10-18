# Filtra Dot em produção — configuração, ativação e verificação

Este documento descreve **o que precisa estar configurado** para o benefício
Filtra Dot funcionar em produção, como verificar a saúde do recurso e como
desligá-lo com segurança (rollback). Ele complementa `docs/DOT_LOCAL.md`.

> Regra deste documento: nunca registrar valores de segredos — apenas nomes de
> variáveis e finalidade.

## 1. Quem tem direito ao benefício (matriz canônica)

| Plano | Dot |
| --- | --- |
| `rei` | ✅ completo |
| `corporativo` (aliases `corp` e `corporate`) | ✅ completo |
| `trial`, `teste` | ❌ (o trial de 7 dias não concede o Dot) |
| `inicial`, `pro`, `ultra` | ❌ |

O gate é único (`services/dotAccessGate.ts`, função `resolveDotGate`) e vale
para **todas** as rotas de empresa (`/api/dot/*` e `/api/dot/agent/*`). Aliases
de plano são normalizados por `normalizePlanAlias` (`lib/plans.ts`) antes da
checagem, de forma consistente com cobrança, relatórios e cotas.

Além do plano, o gate exige: token de acesso válido, empresa existente com
assinatura/trial válidos (`empresaTemAcesso`) e conta que não seja admin da
plataforma. Permissões granulares (por recurso/ação) continuam sendo exigidas
por operação em `services/dotAccessControl.ts`.

## 2. Variáveis de ambiente

Todas são opcionais para o processo iniciar; as marcadas como "produção"
precisam estar definidas para o recurso ficar acessível.

| Variável | Efeito | Padrão |
| --- | --- | --- |
| `FILTRA_DOT_ENABLED` | **Produção.** Monta as rotas do Dot (`/api/dot/*`, `/api/dot/agent/*`) e liga o worker do agente. Sem ela, só existe o tombstone `GET /api/dot/status` → 403. | desligado |
| `DOT_AGENT_WORKER_ENABLED` | `0` desliga o worker do agente (missões em background). | ligado junto do Dot |
| `DOT_AGENT_WORKER_INTERVAL_MS` | Intervalo do worker. Mínimo aplicado: 60000 ms. | `300000` |
| `FILTRA_DOT_FORCE_ON` | **Liga o monitor agendado** (varredura de todas as empresas elegíveis). Requer `FILTRA_DOT_ENABLED=1`. Manter desligado até validar carga/idempotência/recuperação em produção. | desligado |
| `FILTRA_DOT_MONITOR_TICK_MS` | Intervalo do monitor. Mínimo aplicado: 60000 ms. | `300000` |
| `DOT_MISSION_MAX_STEP_ATTEMPTS` | Tentativas por etapa antes de pausar a missão. | `3` |
| `DOT_REI_RESPONSE_TOKENS` | Teto de tokens de saída por resposta no plano Rei. | `1800` |
| `DOT_CORPORATIVO_RESPONSE_TOKENS` | Teto de tokens de saída por resposta no Corporativo. | `1200` |
| `DOT_TOKEN_RESERVATION_TTL_MS` | TTL da reserva de tokens por resposta. | `30000` |
| `DOT_DEMO_MODE` | Modo demonstração sem login — **só tem efeito fora de produção** (em produção é ignorado). | desligado |
| `DOT_ADMIN_SESSION_TTL_MINUTES` | Duração da sessão administrativa do Dot depois do PIN (valores fora de 5–480 usam o padrão). | `30` |
| `GROQ_API_KEY` / `GEMINI_API_KEY` | Provedor de IA para `/api/dot/chat` e `/api/dot/explain` e para as etapas generativas do agente. Sem nenhuma das duas, o chat responde 503 (o restante do Dot funciona). | — |

Banco, JWT e demais variáveis seguem o padrão da API (não são específicas do
Dot). As cotas de tokens do Dot são **isoladas** (`feature='dot'` em
`ai_usage`): não consomem nem são consumidas pelo orçamento de avaliações.

## 3. Sub-sistemas em background e suas garantias

- **Monitor agendado** (`services/dotScheduler.ts`) — varre empresas elegíveis
  (planos Rei/Corporativo, status ativo/trial) e cria eventos/decisões/ações
  preparadas. Fica **desligado** sem `FILTRA_DOT_FORCE_ON=1`. Uma rodada por
  vez, com lock durável (`dotCoordination`) + lock por empresa.
- **Worker do agente** (`services/dotAgentWorker.ts`) — avança missões
  `planned/working` em etapas determinísticas, no máximo 6 por rodada, sem
  chamar IA. Executa por missão com lock em memória + claim durável no banco;
  falhas repetidas pausam a missão em vez de repetir indefinidamente.
  Também é acordado sob demanda (`wakeDotAgentWorker`) quando o usuário cria,
  aprova ou retoma algo — o timer é apenas a rede de recuperação.
- **Barreira de aprovação** (`services/dotExecutionGateway.ts` +
  `dotAgentMissionRunner.ts`) — aprovar **não executa**. A execução exige
  aprovação registrada e permissão de `execute`; nenhuma ação atual tem efeito
  externo (`external_side_effect=false`); executores futuros passam pelo mesmo
  gateway.

## 4. Verificação pós-deploy (com uma conta Rei/Corporativo de teste)

```bash
# 1) Status responde e mostra os sub-sistemas:
curl -s https://api.filtraai.com/api/dot/status -H "Authorization: Bearer $TOKEN"
#    → enabled:true | scheduler.timer_active conforme FORCE_ON | worker.timer_active
#      worker.disabled:false (se o worker estiver desligado, timer_active:false)

# 2) Rotas de empresa respondem para plano autorizado:
curl -s https://api.filtraai.com/api/dot/agent/workspace -H "Authorization: Bearer $TOKEN"

# 3) Plano sem direito recebe 403 com motivo:
#    DOT_AGENT_PLAN_REQUIRED / "acesso antecipado para os planos Rei e Corporativo".

# 4) Sem token e com token inválido: 403.

# 5) Administração do Dot (conta proprietária): estado e conclusão do PIN
curl -s https://api.filtraai.com/api/dot/admin/state -H "Authorization: Bearer $TOKEN"
#    → is_owner:true | pin_configured | session_active
```

Verificações adicionais: hs da API (`/api/health` `ok:true`), log do processo
com `[dot] Filtra Dot habilitado…`, `🤖 DOT agente em background…` e
`[dot-scheduler] candidatos observados …`. O endpoint de status nunca expõe
segredos, valores de cota de outras empresas ou dados de negócio.

## 5. Como desligar (rollback)

- Emergência total: remover `FILTRA_DOT_ENABLED` do serviço e reiniciar →
  rotas recolhidas (somente o tombstone 403 em `/api/dot/status`).
- Parar somente o monitor: remover `FILTRA_DOT_FORCE_ON`.
- Parar somente o worker: `DOT_AGENT_WORKER_ENABLED=0` (missões continuam
  avançando por ação do usuário via `wakeDotAgentWorker`).

Nenhuma dessas mudanças remove dados: missões, decisões, ações, auditoria e
permissões permanecem no banco.

## 6. Limitações conhecidas

- Sem `GROQ_API_KEY`/`GEMINI_API_KEY`, chat/explicação respondem 503 (falha
  segura, sem vazar detalhes em produção).
- O monitor é pesado por natureza; ligar `FILTRA_DOT_FORCE_ON` somente depois
  de acompanhar uma rodada manual (`POST /api/dot/monitor/run`) em horário de
  baixa.
- Este documento cobre o recurso na API. O painel mostra o Dot para planos
  Rei/Corporativo e o uso depende de autenticação de um usuário da empresa.

## 7. Proprietário da empresa, PIN administrativo e sessão exclusiva

Propriedade, permissões e PIN são três camadas separadas:

1. **Proprietário da empresa** (`empresa_owners`, `lib/empresaOwnership.ts`) —
   a única fonte de administração do Dot. Nasce automaticamente no cadastro
   (`source: 'signup'`) e, para empresas criadas antes deste ciclo, é
   provisionado pelo admin da plataforma (seção 8). **Nenhuma decisão usa o
   papel (`role`) do token**: o papel padrão `empresa` não administra nada, e
   empresa sem proprietário provisionado nega por padrão (fail-closed).
2. **Permissões granulares** (`dot_agent_permissions`) — o baseline interno
   concede apenas leitura/análise (`filtra.read`, `filtra.analyze`,
   `operations.read`). Operações com consequência (`create`/`update`/`execute`)
   exigem concessão explícita **ou** são cobertas pela autoridade plena do
   proprietário. A migração roda sozinha no primeiro acesso de cada empresa:
   revoga (idempotente) o baseline antigo — linhas do sistema, sem
   `granted_by` — e preserva qualquer concessão explícita.
3. **PIN administrativo + sessão** (`dot_admin_pins`, `dot_admin_pin_attempts`,
   `dot_admin_sessions`, `services/dotAdminSecurity.ts`):
   - PIN de 6 dígitos (padrões previsíveis são recusados), guardado como hash
     **scrypt com salt individual**; nunca aparece em log, auditoria ou
     mensagem de erro;
   - só o proprietário cadastra (uma única vez), redefine (exigindo a senha da
     conta) ou desbloqueia. Tentativas têm atraso progressivo e bloqueio
     temporário (10 min → 1 h → 24 h; **nunca permanente**) persistido no
     banco — funciona com múltiplas instâncias;
   - a sessão é um token opaco com hash no banco, expira em
     `DOT_ADMIN_SESSION_TTL_MINUTES` (padrão 30), é vinculada a
     empresa+usuário, revogável (`Bloquear`) e **todas as sessões caem quando
     o PIN é redefinido**;
   - operações protegidas exigem também o cabeçalho `X-Dot-Admin: 1`
     (proteção CSRF adicional; o cookie segue a política de SameSite da API).

Matriz de proteção (todas as rotas continuam passando pelo gate de plano):

| Rota | Permissão | Sessão administrativa |
| --- | --- | --- |
| `GET /api/dot/admin/state` | autenticado | não (estado completo só para o proprietário) |
| `POST /api/dot/admin/pin` · `/pin/reset` · `/session` · `DELETE /session` | proprietário | não (é o próprio desbloqueio); cabeçalho obrigatório nas mutações |
| `PUT /api/dot/agent/permissions` | proprietário | **sim** |
| `POST /api/dot/actions/:id/run` | `filtra.execute` | **sim** |
| `POST /api/dot/agent/tools/:id/invoke` | granular da ferramenta | **sim** para ferramentas de execução/envio externo/risco médio-alto (hoje todas são leitura) |
| Leitura, chat, monitor, decisões, followups, goals e missions | como antes | não |

No painel (`/dot`), o cartão **Administração do Dot (PIN)** aparece apenas
para o proprietário e o cabeçalho `X-Dot-Admin` é enviado automaticamente.

## 8. Provisionamento de proprietário em empresas existentes (admin da plataforma)

Empresas criadas antes deste ciclo não têm proprietário e permanecem
**bloqueadas para administração e execução** até o provisionamento — nunca
inferimos proprietário por heurística. Com uma sessão de admin da plataforma
(`ADMIN_EMAIL`/`ADMIN_PASSWORD`):

```bash
# Ver o proprietário atual (ou null):
curl -s https://api.filtraai.com/api/admin/empresas/<id-ou-slug>/owner \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Provisionar pelo e-mail do responsável (o usuário precisa existir e ser da empresa):
curl -s -X POST https://api.filtraai.com/api/admin/empresas/<id-ou-slug>/owner \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"email":"responsavel@empresa.com"}'
#    → {ok:true, owner:{user_id,...}} — auditado em audit_logs (empresa.owner_set)
```

Depois de provisionado, o responsável abre `/dot`, define o PIN e desbloqueia
a administração. Correções futuras usam o mesmo endpoint (sobrescreve o
proprietário anterior, sempre auditado).
