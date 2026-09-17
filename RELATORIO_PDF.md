# Relatório PDF oficial — Filtra.AI

## Fonte oficial

O gerador oficial é `relatorioPdf.ts`, exportando `gerarRelatorioMensalPDF`.

Os antigos geradores PDF duplicados foram removidos. As duas rotas PDF existentes continuam apontando para a mesma implementação para preservar compatibilidade:

- `/api/empresa/:ref/relatorio.pdf`
- `/api/empresa/:ref/relatorio-inteligente.pdf`

## Profundidade por plano

| Plano | Conteúdo principal |
|---|---|
| Trial/Teste | Base Ultra |
| Pro | KPIs + distribuição 1★–5★ |
| Ultra | Pro + sentimento + temas/tags |
| Corporativo | Ultra + ranking por unidade |
| Rei | Corporativo + recursos avançados previstos pelo layout oficial |

A elegibilidade do PDF é definida por `planTemPdf/empresaTemPdf` em `lib/plans.ts`.

## Multiunidades

A inicialização de unidades é responsabilidade de `lib/unidades.ts`. O servidor executa `ensureUnidadesSchema(getDb())` no bootstrap.

O PDF apenas consulta as unidades quando necessário; ele não cria nem migra o schema.

## Observação importante

O PDF mensal recebe um `mesAno` (`YYYY-MM`) e usa as avaliações reais do período, ignorando registros marcados como teste.

Para alterações futuras no visual ou nos indicadores, editar primeiro `relatorioPdf.ts` e manter os demais módulos independentes.
