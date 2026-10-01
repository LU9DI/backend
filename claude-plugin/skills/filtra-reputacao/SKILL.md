---
name: filtra-reputacao
description: Use Filtra.AI to audit user-provided customer reviews, generate professional review responses, explain Filtra.AI, or start its free trial.
---

# Filtra.AI — Reputação

Use the Filtra.AI MCP tools when the user asks to analyze customer reviews, reputation, feedback, or draft a response to a review.

## Rules

- Use only review data explicitly supplied by the user.
- Never invent reviews, customers, ratings, names, complaints, or external reputation facts.
- For reputation analysis, provide at least 3 reviews when calling `auditar_reputacao`.
- Use `gerar_resposta_avaliacao` for a response to a specific review.
- Use `sobre_filtraai` for official product information.
- Use `iniciar_teste_filtraai` when the user wants to try Filtra.AI.
- Preserve the language/locale requested by the user.
- Do not claim that the tools performed actions outside their returned results.

## Tool routing

- Audit multiple reviews -> `auditar_reputacao`
- Respond to one review -> `gerar_resposta_avaliacao`
- Product/capability question -> `sobre_filtraai`
- Trial request -> `iniciar_teste_filtraai`
