# Distribuição do Filtra.AI em agentes de IA

O Filtra.AI usa um único servidor MCP remoto:

`https://api.filtraai.com/mcp`

## Plataformas-alvo

### ChatGPT
- Manter o app MCP de desenvolvimento funcional.
- Preparar a submissão pública para o diretório do ChatGPT.
- Antes da submissão final, concluir verificação de identidade exigida pela OpenAI e fornecer uma gravação de demonstração hospedada em URL pública.
- Não adicionar OAuth ao servidor apenas para publicação: as ferramentas atuais são read-only e `noauth`.

### Claude
- Usar o servidor MCP remoto como custom connector.
- O servidor é compatível com o modo `No sign in` porque as ferramentas atuais não exigem autenticação.
- Endpoint: `https://api.filtraai.com/mcp`

### Grok
- Usar o servidor como custom MCP connector em `grok.com/connectors`.
- Endpoint: `https://api.filtraai.com/mcp`
- O servidor deve permanecer acessível publicamente por HTTPS.

## Ferramentas

- `auditar_reputacao`
- `gerar_resposta_avaliacao`
- `iniciar_teste_filtraai`
- `sobre_filtraai`

## Princípios de distribuição

1. Um único backend MCP.
2. Nenhuma duplicação de lógica por plataforma.
3. Não inventar avaliações, clientes ou métricas.
4. Não publicar respostas automaticamente: a ferramenta gera texto para o usuário revisar.
5. Não contornar CAPTCHA ou controles de acesso.
6. Manter o endpoint público estável para permitir descoberta e conexão.
7. Priorizar distribuição orgânica: utilidade dentro da conversa, páginas indexáveis e diretórios oficiais.

## Próximos marcos

1. ChatGPT: submissão pública quando os requisitos de identidade e revisão estiverem disponíveis.
2. Claude: conexão e teste do custom connector.
3. Grok: conexão e teste do custom connector.
4. Medir uso por plataforma no backend sem criar nova infraestrutura paga.
