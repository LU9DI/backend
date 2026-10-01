# Filtra.AI para Claude

Plugin bundle do Filtra.AI para Claude.

## Conteúdo

- `.claude-plugin/plugin.json`: manifesto do plugin.
- `.mcp.json`: servidor MCP remoto oficial do Filtra.AI.
- `skills/filtra-reputacao/SKILL.md`: instruções de uso das ferramentas.

## MCP

Servidor remoto:

https://api.filtraai.com/mcp

O servidor atual não exige autenticação. As ferramentas disponíveis são:

- `auditar_reputacao`
- `gerar_resposta_avaliacao`
- `iniciar_teste_filtraai`
- `sobre_filtraai`

## Privacidade

O fluxo de auditoria usa somente os dados de avaliações fornecidos pelo usuário. Consulte:

- https://filtraai.com/privacidade
- https://filtraai.com/suporte

## Teste

https://filtraai.com/preview/teste
