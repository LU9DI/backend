# Nota fiscal — Filtra.AI

## Decisão de arquitetura

O Filtra.AI vende serviço/SaaS. A cobrança do Stripe gera uma invoice/fatura comercial, mas isso não substitui a NFS-e brasileira.

A emissão fiscal deve ficar desacoplada do pagamento:
1. pagamento confirmado;
2. ativação da assinatura;
3. criação idempotente de uma solicitação fiscal;
4. emissão assíncrona da NFS-e;
5. consulta/webhook do provedor;
6. persistência de número, código de verificação, XML/PDF e status;
7. envio ao cliente;
8. falha fiscal gera retry, sem desfazer o pagamento.

## Padrão fiscal

A integração deve priorizar NFS-e de padrão nacional, mantendo um adaptador para particularidades municipais.

A Receita informa que a emissão via API exige credenciamento prévio no Painel do Contribuinte. Em 2026, houve mudanças relevantes no padrão nacional e na adaptação da NFS-e à Reforma Tributária.

## Provedor recomendado para a primeira integração

Usar um provedor fiscal especializado por API, inicialmente Focus NFe, em vez de implementar comunicação direta com cada prefeitura.

Motivos técnicos:
- API REST/JSON;
- NFS-e municipal e NFS-e Nacional;
- processamento assíncrono;
- consulta/webhooks;
- abstração das particularidades municipais.

A escolha do provedor deve ficar atrás de uma interface interna para permitir troca futura.

## Dados que o Filtra.AI precisará

### Emitente
- CNPJ;
- razão social;
- inscrição municipal;
- município/UF;
- código do serviço;
- tributação/regime;
- alíquota quando aplicável;
- certificado/configuração exigidos pelo provedor;
- token da API.

### Tomador
- nome/razão social;
- CPF/CNPJ;
- e-mail;
- endereço quando exigido;
- município/UF;
- dados adicionais exigidos pelo município/provedor.

Não devemos emitir uma nota usando dados inventados ou incompletos. Se o cadastro fiscal obrigatório estiver ausente, o pagamento continua válido e a emissão fica em estado aguardando_dados_fiscais.

## Idempotência

A chave fiscal deve ser determinística, por exemplo: empresa_id + ciclo_de_cobranca + payment_event_id.

Uma mesma cobrança nunca pode gerar duas NFS-e por retry de webhook.

## Estados

pending -> processing -> authorized

Possíveis finais:
- authorized
- rejected
- cancelled

Erros transitórios devem permanecer em retry. Erros cadastrais devem ficar visíveis para correção, sem bloquear o acesso pago.

## Regra importante

A emissão fiscal é um módulo independente do pagamento.

Falha na NFS-e não pode cancelar assinatura, bloquear dashboard ou fazer o webhook de pagamento retornar erro depois que a cobrança já foi confirmada.

## Próxima implementação

Antes de ativar emissão real, configurar:
- credenciamento fiscal do emitente;
- provedor escolhido;
- dados tributários;
- ambiente de homologação;
- certificado, quando exigido;
- webhook do provedor.

Depois disso, implementar o adaptador NFS-e e conectar os três fluxos de pagamento atuais: Stripe, PayPal e Mercado Pago/Pix.