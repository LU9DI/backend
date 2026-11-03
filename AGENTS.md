# AGENTS.md — backend (API Filtra.AI)

> Contexto para agentes de IA. Complementa os guias em `docs/` e os `*.md` da raiz.

## Objetivo
API da Filtra.AI: trial → planos (Stripe/Pix/PayPal) → avaliações filtradas → IA (Groq/Gemini) → painel cliente e admin. Inclui DOT (assistente), MFA/WebAuthn, relatório profissional e integrações MCP.

## Limites de segurança (NÃO fazer)
- Nunca commitar `.env` ou segredos; use variáveis protegidas do ambiente de execução.
- Não reintroduzir geração de arquivos de relatório — o relatório é **JSON-first**; endpoints legados retornam **410 Gone** (`FINISH.md`).
- Não habilitar `SQLITE_ALLOW_PROD`; SQLite é só desenvolvimento.
- Manter `CORS_ORIGINS` restrito ao frontend.
- Evitar reescrever o motor de IA, o fluxo de trial, o login de funcionários ou migrar banco sem testes direcionados (`PROXIMOS_PASSOS_SEGUROS.md`).

## Runtime e implantação
- Runtime da API: Node.js.
- Hospedagem da API: Render.
- Banco de produção: PostgreSQL no Supabase.
- Frontend: Cloudflare Pages.
- Não adicionar provedores alternativos de deploy sem decisão arquitetural explícita.

## Comandos de teste e validação
```bash
npm ci
npm run build     # tsc --noEmit
npm test          # node scripts/run-tests.mjs
npm run audit
```

## Skills obrigatórios por contexto
- Para autenticação, autorização por tenant, sessões/JWT, MFA/WebAuthn, webhooks, CORS, rate limiting ou testes de segurança: leia `.agents/skills/api-auth-test-review/SKILL.md`.
- Para toda implementação, correção ou refatoração: siga `.agents/skills/verification-gates/SKILL.md`.

## Dependências
Família Filtra.AI (relacionado a `dot-local` e `saas-render-check`; reconciliar sem sync automático).

## Pendências conhecidas
- Sem `README.md` na raiz.
- Versionados indevidamente: `database.sqlite`, `prisma/dev.db`, `dist/`.
- `.agents/mcp_config.json` versionado com **placeholder** de segredo — trocar por variável de ambiente.
