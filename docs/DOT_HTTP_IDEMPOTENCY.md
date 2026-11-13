# Filtra DOT — contrato de idempotência HTTP

Status: requisito obrigatório antes de habilitar `POST /api/dot/chat` ou `POST /api/dot/explain` em produção.

## Objetivo

Impedir que timeout, reconexão, retry do navegador, failover de API ou repetição do cliente gere uma segunda execução/cobrança para a mesma mensagem lógica. A idempotência do ledger de orçamento (reserva/liquidação) não substitui a idempotência HTTP.

## Cabeçalho e escopo

- O cliente envia `X-Idempotency-Key` em toda chamada de chat e explain em produção (o backend também aceita `Idempotency-Key`).
- A chave é um UUID aleatório (ou valor criptograficamente aleatório equivalente), gerado uma vez por envio lógico.
- O cliente persiste a chave junto ao payload pendente e reutiliza exatamente a mesma chave e payload em qualquer retry/failover.
- Uma nova mensagem intencional recebe chave nova, mesmo se o texto for igual.
- O servidor limita tamanho/formato da chave e calcula SHA-256 de uma representação canônica do payload relevante (`message`, `session_id`, `response_text` e demais campos que afetem a resposta).
- A unicidade é por tenant autenticado + chave. O tenant vem exclusivamente de `resolveDotAccess`, nunca do body ou header.
- Em produção, chave ausente/inválida é recusada antes de cache, contexto, reserva ou provedor. Resposta: HTTP 400, código `DOT_IDEMPOTENCY_KEY_REQUIRED` ou `DOT_IDEMPOTENCY_KEY_INVALID`.
- Não compartilhar namespace de idempotência entre empresas. A rota demo deve ter escopo isolado e explícito; não pode usar um tenant fictício compartilhado.

## Persistência

Criar tabela central por migração, não DDL no caminho da requisição. Campos mínimos:

- `id`, `empresa_id`, `idempotency_key`, `request_hash`
- `status`: `processing`, `completed`, `ambiguous`, `failed_safe`
- `response_status`, `response_json` (JSON serializado), `created_at`, `updated_at`, `completed_at`
- restrição única em `(empresa_id, idempotency_key)`
- índice de consulta por tenant/status/updated_at

A criação/claim deve ser atômica e protegida pela restrição única. Não usar `Date.now()`, sessão ou cache em memória como identidade de uma execução. A tabela deve ser compartilhada por todas as instâncias Render.

## Comportamento obrigatório

| Estado encontrado | Condição | Resultado |
|---|---|---|
| inexistente | claim atômico vence | esta requisição é a única autorizada a prosseguir |
| qualquer estado | hash diferente | HTTP 409 `DOT_IDEMPOTENCY_KEY_REUSED`; nunca executar |
| processing | outra requisição está em curso | HTTP 409/425 `DOT_REQUEST_IN_PROGRESS`; nunca chamar provedor |
| completed | mesma chave/hash | reproduzir status e JSON originais, sem contexto, reserva ou provedor |
| ambiguous | provedor pode ter processado | HTTP 409/503 `DOT_REQUEST_AMBIGUOUS`; nunca repetir; exige reconciliação |
| failed_safe | falha comprovada antes do envio | retry só por transição condicional e auditável que prove que nenhum provedor processou; se não houver prova, manter bloqueado |

O estado `processing` encontrado após reinício ou expiração de lease não pode ser retomado automaticamente: deve ser promovido/interpretado como `ambiguous` e bloqueado. Um lease não prova que a chamada externa não ocorreu.

## Ordem obrigatória no handler

1. Resolver autenticação/tenant e validar método, body e chave.
2. Calcular hash canônico.
3. Fazer claim durável/consultar conflito.
4. Reproduzir `completed`, ou recusar `processing`/`ambiguous`/hash divergente.
5. Só o dono do claim pode carregar contexto e consultar caches.
6. Respostas vindas de cache também são gravadas como `completed` com status/JSON completos antes de responder.
7. Antes do provedor, marcar o ledger financeiro como enviado conforme o contrato atual.
8. Se a chamada puder ter saído, manter estado HTTP como `ambiguous` até persistir resposta final. Só marcar `completed` depois de armazenar o JSON/status que será reproduzido.
9. Se houver falha comprovadamente anterior ao envio, marcar `failed_safe` e aplicar política explícita de retry seguro.
10. Nunca devolver sucesso ao cliente se não foi possível persistir o resultado reproduzível. Falha de persistência após chamada externa é ambígua.

A gravação de resposta e a transição para `completed` devem ser atômicas. A janela de replay da resposta é de 24 horas; após esse prazo, o backend apaga somente `response_json` e preserva indefinidamente a tombstone (`empresa_id`, `endpoint`, `idempotency_key`, `request_hash`, `status`, timestamps). Uma repetição da mesma chave/hash recebe HTTP 409 `DOT_IDEMPOTENCY_RESULT_EXPIRED`; hash diferente continua recebendo `DOT_IDEMPOTENCY_KEY_REUSED`. Nunca apagar tombstones `completed`, `ambiguous` ou `failed_safe` automaticamente: isso reabriria a chave e poderia duplicar execução.

## Contrato de resposta

- Replays `completed` reproduzem o status HTTP e o JSON original (incluindo `session_id`, campos de orçamento e metadados), com um indicador de replay opcional em header (`Idempotency-Replayed: true`, exposto ao navegador via `Access-Control-Expose-Headers`), sem alterar o corpo original.
- Conflitos/in-flight/ambiguous usam códigos estáveis e mensagens que não revelem dados de outro tenant.
- O corpo armazenado não pode conter segredos, credenciais ou dados de outro tenant. Aplicar o mesmo controle de acesso e sanitização da resposta original.

## Reconciliação operacional de tentativas HTTP ambíguas

- Cada claim de chat ou explain vincula sua reserva financeira (`reservation_id`) antes de marcar o envio ao provedor. Se a associação falhar, a chamada não é enviada e a reserva é liberada como comprovadamente não enviada. Se a marcação de envio falhar, a rota também tenta liberar a reserva; o `failed_safe` limpa a associação HTTP para permitir nova reserva no retry. Se a liberação falhar por indisponibilidade do banco, a reserva sem `sent_at` permanece conservadoramente comprometida até o sweep de expiração.
- `GET /api/admin/dot/http-idempotency` é exclusivo de operador da plataforma (`autenticarToken` + `isAdminUser`) e retorna somente metadados mínimos: ID, tenant, endpoint, prefixos da chave/hash, timestamps e ID da reserva. Nunca retorna chave completa, prompt ou resposta.
- `POST /api/admin/dot/http-idempotency/reconcile` exige operador da plataforma e `X-Dot-Admin: 1`. A decisão financeira é aplicada à reserva vinculada pelo serviço de ledger, que valida `pending`, `ambiguous=1` e, para release, `sent_at IS NULL` sob lock transacional.
- Toda decisão é registrada em `audit_logs` como `dot.http_idempotency_reconciled`, incluindo ator, tenant, ID HTTP, reserva, decisão, justificativa e a garantia `idempotency_key_remains_blocked=true`.
- **A reconciliação financeira nunca reabre a chave HTTP.** Mesmo após `settle` ou `release`, a linha continua `ambiguous`; o cliente não pode reproduzir nem executar novamente a mesma mensagem. Uma nova mensagem do usuário deve receber nova chave somente quando se tratar realmente de uma nova intenção, nunca como workaround de uma tentativa cujo resultado segue incerto.
- Registros sem reserva vinculada permanecem bloqueados e retornam `DOT_HTTP_RECONCILE_NO_RESERVATION`; não existe liberação automática.

## Retenção e reconciliação operacional (estado atual)

- `completed`: resposta reproduzível por 24 horas; depois, somente o corpo é apagado e a chave permanece terminal.
- `failed_safe`: permanece registrada; retry é permitido somente pela transição condicional existente que registra prova de não envio.
- `ambiguous`: permanece bloqueada e não é expurgada.
- A fila e a rota de reconciliação HTTP exclusiva de operador estão implementadas. A rota resolve somente a reserva financeira vinculada; não altera o estado terminal da chave HTTP.
- A auditoria das decisões administrativas é inserida na mesma transação PostgreSQL/SQLite da liquidação ou liberação. Se a gravação falhar, a mutação financeira e o consumo são revertidos.
- A rota não consulta automaticamente o provedor nem determina tokens: a evidência e a decisão continuam sendo responsabilidade do operador. Registros sem reserva vinculada permanecem bloqueados para investigação manual.

## Testes de aceitação obrigatórios

1. Duas chamadas concorrentes, mesma chave/hash: uma única chamada ao provedor e uma única reserva.
2. Mesmo retry após conclusão: mesma resposta HTTP/JSON e nenhuma segunda chamada/reserva/linha `ai_usage`.
3. Mesma chave com payload alterado: 409 e nenhuma chamada adicional.
4. Requisição ainda `processing`: 409/425 e nenhuma chamada adicional.
5. Timeout após possível envio: estado ambíguo, retry bloqueado e nenhuma segunda chamada.
6. Falha comprovada antes do envio: transição segura testada; nunca inferir segurança apenas de timeout.
7. Cache factual e cache semântico: resultado persistido/reproduzido; retry não recalcula contexto nem chama provedor.
8. Reinício entre claim e resposta: estado não concluído não é retomado nem reenviado automaticamente.
9. Isolamento multi-tenant: mesma chave em tenants diferentes não colide nem permite replay cruzado.
10. PostgreSQL multi-processo: claim concorrente usa índice único e transação real; não depender de mutex em memória.
11. Chave ausente/inválida em produção: recusada antes de qualquer efeito colateral.
12. Migração idempotente em SQLite de teste e PostgreSQL; schema ausente deve falhar fechado.

## Cobertura automatizada registrada

`tests/dotHttpIdempotency.test.ts` cobre claim concorrente, replay, payload
divergente, endpoint divergente, expiração/tombstone, tenant isolado,
`failed_safe`, ambiguidade e persistência da resposta.

`tests/dotChatLedger.http.test.ts` cobre, para `/api/dot/explain`, replay
sem segunda chamada ou débito, chave reutilizada com conteúdo diferente,
duas chamadas simultâneas, timeout ambíguo sem retry, recusa explícita do
provedor com retry seguro, falha ao vincular a reserva, falha ao marcar envio
e flag geral do DOT desligada em produção. O provedor é simulado;
nenhuma chamada externa é feita. A presença dos testes no repositório não
significa que tenham sido executados ou aprovados: exigir CI verde no HEAD
final, incluindo build e PostgreSQL multi-processo.

## Bloqueio de produção

Não mesclar/implantar/ativar `FILTRA_DOT_ENABLED=1` até backend e cliente real implementarem este contrato, CI passar no HEAD final, revisão independente aprovar as transições e a migração ser validada em ambiente descartável/staging.
