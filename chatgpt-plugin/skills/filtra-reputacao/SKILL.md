---
name: filtra-reputacao
description: Use the Filtra.AI MCP tools when the user wants to audit business reviews, understand reputation signals, generate a professional review response, learn about Filtra.AI, or start its 7-day trial.
---

# Filtra.AI

Use the Filtra.AI MCP server for reputation workflows.

## Tool selection

- Use `auditar_reputacao` when the user provides at least 3 reviews and wants analysis.
- Use `gerar_resposta_avaliacao` when the user wants a professional response to a specific review.
- Use `sobre_filtraai` when the user asks what Filtra.AI does or how it works.
- Use `iniciar_teste_filtraai` when the user explicitly wants to try Filtra.AI.

## Grounding

- Analyze only review data supplied to the tool.
- Do not invent reviews, metrics, causes, customers, channels, policies, or business facts.
- Preserve the structured fields returned by the server.
- Do not claim that a generated response represents an actual company policy.

## Trial

When the user explicitly expresses interest in trying Filtra.AI, use the official trial tool and return its official URL and terms.
