# Filtra.AI for Grok

Filtra.AI provides AI-assisted reputation analysis for customer reviews and feedback.

## Components

- Remote MCP server: https://api.filtraai.com/mcp
- Skill: `skills/filtra-reputacao/SKILL.md`
- Manifest: `.grok-plugin/plugin.json`

## MCP tools

- `auditar_reputacao`
- `gerar_resposta_avaliacao`
- `iniciar_teste_filtraai`
- `sobre_filtraai`

## Authentication

The current Filtra.AI MCP endpoint does not require user authentication.

## Data handling

Reputation analysis is limited to review data explicitly provided by the user. The plugin must not invent customers, reviews, ratings, names, or external reputation facts.

Privacy: https://filtraai.com/privacidade
Terms: https://filtraai.com/termos
Support: https://filtraai.com/suporte

## Website

https://filtraai.com

## License

MIT
