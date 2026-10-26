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
npm test          # tsx --test tests/**/*.test.ts
npm run audit
```

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


## Agent skill routing
- New or changed HTTP routes and response contracts: read .agents/skills/api-design-principles/SKILL.md.
- JWT, MFA/WebAuthn, password reset, cookies, sessions, roles, or tenant access: read .agents/skills/auth-implementation-patterns/SKILL.md.
- Security-sensitive route review and regression tests, especially payment callbacks or MCP entry points: read .agents/skills/api-auth-test-review/SKILL.md.
- Preserve the JSON-first report contract, restricted CORS policy, and documented SQLite development-only boundary above.
