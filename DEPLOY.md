# Deploy — Filtra.AI

A API de produção usa o runtime Node e o relatório profissional estruturado como formato canônico.

## Runtime atual

- Produção: Render (`filtra-ia-api`).
- Backup: Oracle Cloud Always Free, quando provisionado.
- Frontend: Cloudflare Pages.
- Relatórios: JSON-first, exibidos no painel e distribuídos por e-mail, WhatsApp, SMS e WeChat.
- O runtime não depende de Chromium, Puppeteer ou geração de arquivos para relatórios.

## Validação

O healthcheck principal é `/api/live`; a prontidão completa fica em `/api/ready`.
O endpoint `/api/health` expõe informações operacionais e o marcador de build.

A branch `feat/professional-reports-v2` consolida a migração para relatório profissional estruturado. Não trate branches antigas ou marcadores históricos como indicação do runtime atual.

## Relatório profissional

Trial e planos Pro+ possuem relatório profissional estruturado. O plano Inicial não inclui relatórios.

O relatório é um objeto JSON versionado e serve como fonte única para painel e distribuição multicanal. Endpoints legados de arquivo retornam 410 Gone.
