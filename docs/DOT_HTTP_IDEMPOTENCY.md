# Filtra DOT — contrato de idempotência HTTP do chat

Status: requisito obrigatório antes de habilitar `POST /api/dot/chat` em produção.

## Objetivo

Impedir que timeout, reconexão, retry do navegador, failover de API ou repetição do cliente gere uma segunda execução/cobrança para a mesma mensagem lógica. A idempotência do ledger de orçamento (reserva/liquidação) não substitui a idempotência HTTP.

## Cabeçalho e escopo

- O cliente envia `X-Idempotency-Key` em toda chamada de chat de produção.
- A chave é um UUID aleatório (ou valor criptograficamente aleatório equivalente), gerado uma vez por envio lógico.
- O cliente persiste a chave junto ao payload pendente e reutiliza exatamente a mesma chave e payload em qualquer retry/failover.
- Uma nova mensagem intencional recebe chave nova, mesmo se o texto for igual.
- O servidor limita tamanho/formato da chave e calcula SHA-256 de uma representação canônica do payload relevante (`message`, `session_id` e demais campos que afetem a resposta).
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

A gravação de resposta e a transição para `completed` devem ser atômicas. Não remover registros enquanto a chave ainda puder ser reutilizada por retries do cliente; retenção e expurgo exigem janela formal documentada.

## Contrato de resposta

- Replays `completed` reproduzem o status HTTP e o JSON original (incluindo `session_id`, campos de orçamento e metadados), com um indicador de replay opcional em header, sem alterar o corpo original.
- Conflitos/in-flight/ambiguous usam códigos estáveis e mensagens que não revelem dados de outro tenant.
- O corpo armazenado não pode conter segredos, credenciais ou dados de outro tenant. Aplicar o mesmo controle de acesso e sanitização da resposta original.

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

## Bloqueio de produção

Não mesclar/implantar/ativar `FILTRA_DOT_ENABLED=1` até backend e cliente real implementarem este contrato, CI passar no HEAD final, revisão independente aprovar as transições e a migração ser validada em ambiente descartável/staging.
