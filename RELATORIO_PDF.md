# Relatório profissional (substitui o PDF)

O relatório do Filtra.AI deixou de ser um arquivo PDF como produto principal.

## Fonte única

A API entrega um objeto JSON estruturado por período:

- resumo executivo;
- KPIs;
- distribuição de estrelas;
- sentimento;
- temas recorrentes;
- unidades;
- riscos;
- oportunidades;
- recomendações;
- benefícios do plano atual;
- comparação entre planos;
- narrativa didática: **o que aconteceu → por que importa → onde atuar → riscos → oportunidades → o que fazer agora**;
- versões prontas para e-mail, WhatsApp, SMS e WeChat.

A estrutura é deliberadamente previsível para que automações e modelos de IA consigam transformar o mesmo dado em diferentes formatos sem depender de PDF, OCR ou layout de página.

## Rotas

- `GET /api/empresa/:ref/relatorio?mes=YYYY-MM` — relatório profissional estruturado.
- `POST /api/empresa/:ref/relatorio/enviar` — distribuição por canais.
- `GET /api/empresa/:ref/relatorio.pdf` — **410 Gone**; PDF foi descontinuado como formato de produto.

## Benefícios por plano

O relatório retorna `plano.beneficios_incluidos` e `plano.comparativo` com os cinco planos oficiais:

1. Inicial
2. Pro
3. Ultra
4. Corporativo
5. REI

REI herda os benefícios do Corporativo e acrescenta inteligência estratégica, incluindo radar estratégico, oportunidades de crescimento e relatório executivo.

## PDF legado

Os geradores antigos podem permanecer temporariamente no repositório para recuperação histórica/testes, mas não devem ser montados no painel nem usados pela rota principal. Novas funcionalidades devem consumir o relatório estruturado.
