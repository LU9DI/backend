# AGENTS.md — backend (API Filtra.AI)

> Contexto para agentes de IA. Gerado em 2026-10-15. Complementa (não substitui) os guias em `docs/` e os `*.md` da raiz.

## Objetivo
API da Filtra.AI: trial → planos (Stripe/Pix/PayPal) → avaliações filtradas → IA (Groq/Gemini) → painel cliente e admin. Inclui DOT (assistente), MFA/WebAuthn, relatório profissional e integrações MCP.

## Limites de segurança (NÃO fazer)
- Nunca commitar `.env` ou segredos; use variáveis do ambiente (Jataí/Cloudflare).
- Não reintroduzir geração de arquivos de relatório — o relatório é **JSON-first**; endpoints legados retornam **410 Gone** (`FINISH.md`).
- Não habilitar `SQLITE_ALLOW_PROD`; SQLite é só desenvolvimento.
- Manter `CORS_ORIGINS` restrito ao frontend.
- Evitar reescrever o motor de IA, o fluxo de trial, o login de funcionários ou migrar banco sem testes direcionados (`PROXIMOS_PASSOS_SEGUROS.md`).

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

## Estado atual (Git)
- Branch: `feat/professional-reports-v2` (0 atrás / 71 à frente de `origin/master`); 111 branches remotas.
- Não rastreado: `.jatai.yml`. Stash: `preservar deno.lock antes do deploy jatai`.
- **Fonte canônica provável da API Filtra.AI** (ver `../FiltraAI-FONTE-CANONICA.md`) — pendente de confirmação.

## Dependências
Família Filtra.AI (relacionado a `dot-local` e `saas-render-check`; reconciliar sem sync automático).

## Pendências conhecidas
- Sem `README.md` na raiz.
- Versionados indevidamente: `database.sqlite`, `prisma/dev.db`, `dist/`.
- `.agents/mcp_config.json` versionado com **placeholder** de segredo — trocar por variável de ambiente.
