# Multi-Product Platform

Base isolada para futuros produtos, sem alterar o runtime do Filtra.AI.

## Compartilhado
- autenticação/autorização
- PostgreSQL e acesso a dados
- billing/planos
- IA (Groq/Gemini e failover)
- e-mail, notificações e push
- segurança, rate limiting, métricas e auditoria
- webhooks, jobs e retry queue

## Produtos independentes
- products/shopping-agent — agente pessoal de compras
- products/business-agents — automação para pequenos negócios
- products/agent-marketplace — marketplace de agentes
- products/tax-platform — plataforma tributária brasileira

O Filtra.AI continua sendo o produto de produção. Esta árvore não é montada no server.ts do Filtra.AI nem altera suas rotas/schemas de produção.

## Estratégia
1. master permanece intacto.
2. A fundação é desenvolvida nesta branch.
3. Quando validada, a camada compartilhada pode ser extraída para pacote/repositório próprio.
4. Cada produto terá frontend, rotas, schemas e deploy próprios.
5. Código de domínio de um produto não deve ser importado por outro.
