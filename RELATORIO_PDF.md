# Relatórios PDF por plano

## O que mudou

Os PDFs deixam de ser só caixas de KPI e passam a ter **gráficos nativos (PDFKit)** e, nos planos multi-unidade, **quebra de página por filial**.

| Plano | Gráficos | Filiais |

| **Pro / Ultra** | Barras de distribuição 1★–5★ + bloco IA simples | Não |
| **Corporativo** | Distribuição + **ranking de unidades** + **1 página por filial** (KPIs + barras) | Sim |
| **Rei** | Tudo do Corporativo + **donut** positivas/críticas + **barras horizontais de gargalos** + donut também em cada filial | Sim |

## Arquivos

- `backend/relatorioPdf.ts` — geração completa
- `ensureUnidadesSchema(db)` — cria tabela `unidades` e colunas `reviews.unidade_id` / `reviews.origin`

## Como ligar no server.ts

```ts
import { gerarRelatorioMensalPDF, ensureUnidadesSchema } from './relatorioPdf.js';

// dentro de initDB(), após criar tabelas:
await ensureUnidadesSchema(db);

// substituir a função antiga gerarRelatorioMensalPDF por:
// (ou no endpoint /api/relatorio/mensal)
const pdf = await gerarRelatorioMensalPDF(db, empresaId, mesAno, callGroq);
res.type('application/pdf').send(pdf);
```

Remova a implementação antiga inline em `server.ts` para evitar conflito de nomes.

## Cadastro de filiais (Corporativo / Rei)

```sql
INSERT INTO unidades (id, empresa_id, nome, slug, ativo)
VALUES ('uuid-aqui', 'empresa_id', 'Filial Centro', 'filial-centro', 1);
```

Nas avaliações, grave `unidade_id` (ou `origin` como fallback de canal/unidade).

Se não houver filiais cadastradas, o relatório Corporativo/Rei ainda gera a página **Matriz / Geral** com os dados agregados e o ranking com uma linha.

## Elegibilidade

`pro`, `ultra`, `corporativo`, `rei`.

(Inicial e teste continuam sem PDF mensal.)
