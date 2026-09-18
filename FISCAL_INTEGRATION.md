# Integração fiscal — Filtra.AI

## Estado

A infraestrutura de NFS-e está preparada, mas a emissão real permanece desligada até a configuração fiscal e homologação.

O Filtra.AI é prestador do serviço. A empresa cliente é o tomador da NFS-e.

## Variáveis

`FISCAL_ENABLED=1`
`FOCUS_NFE_TOKEN=...`
`FOCUS_NFE_ENV=homologacao` ou `producao`
`FISCAL_CODIGO_MUNICIPIO=...`
`FISCAL_CODIGO_TRIBUTACAO_ISS=...`
`FISCAL_DESCRICAO_SERVICO=...`
`FISCAL_CODIGO_SIMPLES=...`
`FISCAL_REGIME_ESPECIAL=...`
`FISCAL_TRIBUTACAO_ISS=1`
`FISCAL_WEBHOOK_TOKEN=...`

A autenticação da Focus NFe usa HTTP Basic com o token como usuário e senha vazia. Homologação usa `https://homologacao.focusnfe.com.br`; produção usa `https://api.focusnfe.com.br`.

## Fluxo

1. Pagamento confirma.
2. `activatePlan` cria o registro fiscal idempotente.
3. O documento fica `pending`.
4. O processamento é disparado pelo endpoint autenticado do documento.
5. A Focus aceita ou rejeita a requisição.
6. Se aceitar, o documento fica `processing`.
7. Webhook/consulta atualiza para `authorized`, `rejected` ou `cancelled`.

A falha fiscal não desativa a assinatura.

## Dados do tomador

Cada empresa cliente possui um perfil em `fiscal_recipient_profiles` com:
- nome;
- CPF ou CNPJ;
- e-mail;
- código IBGE do município.

## Homologação

Use primeiro o ambiente de homologação. Documentos de homologação não possuem validade fiscal. Só mude para produção após confirmar:
- CNPJ emissor;
- credenciamento para API;
- regime tributário;
- código de tributação nacional do ISS;
- município de emissão/prestação;
- configuração da Focus;
- webhook;
- regras definidas com contador.

## Fontes

- Governo: https://www.gov.br/pt-br/servicos/emitir-nota-fiscal-de-servico-eletronica
- NFS-e técnica: https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual
- Focus: https://doc.focusnfe.com.br/reference/emitir_dps_nacional
