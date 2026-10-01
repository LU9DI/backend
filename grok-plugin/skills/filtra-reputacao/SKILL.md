---
name: filtra-reputacao
description: Use Filtra.AI to audit user-provided customer reviews, generate professional review responses, explain Filtra.AI, or start its free trial.
---

# Filtra.AI — Reputação

Use the Filtra.AI MCP tools for customer-review and reputation workflows.

## Rules

- Analyze only review data explicitly supplied by the user.
- Never invent reviews, customers, ratings, names, complaints, or external reputation facts.
- For an audit, provide at least 3 reviews before calling `auditar_reputacao`.
- Use `gerar_resposta_avaliacao` for a response to a specific review.
- Use `sobre_filtraai` for official product information.
- Use `iniciar_teste_filtraai` when the user wants to try Filtra.AI.
- Preserve the requested language and locale.
- Do not claim actions or facts that are not present in tool results.
