# Relatórios PDF por plano

Geração em `relatorioPdf.ts`. Cache no endpoint evita gastar tokens de IA em re-download.

## Níveis

| Plano | Conteúdo |
|-------|----------|
| **Inicial** | Sem PDF mensal |
| **Pro** | Capa Filtra.AI · KPIs (volume, média, críticas, positivas) · barras 1★–5★ · positivas vs críticas |
| **Ultra** (+ Trial) | Tudo do Pro · sentimento (pos/neu/neg) · temas detectados pela IA |
| **Corporativo** | Tudo do Ultra · ranking de unidades · **1 página por filial** (KPIs + barras) |
| **Rei** | Tudo do Corp · **donut** positivas/críticas · barras de gargalos · donut + temas **por filial** |

## Visual

- Cabeçalho navy + faixa índigo
- Cards de KPI com acento lateral
- Gráficos nativos (PDFKit)
- Rodapé com data de emissão e numeração de páginas

## Filiais (Corp / Rei)

```sql
INSERT INTO unidades (id, empresa_id, nome, slug, ativo)
VALUES ('uuid', 'empresa_id', 'Filial Centro', 'filial-centro', 1);
```

Nas reviews: `unidade_id` ou `origin` = slug. Sem filiais cadastradas, usa página **Matriz / Geral**.

## Elegibilidade

`planTemPdf` / `empresaTemPdf` em `lib/plans.ts`: pro, ultra, corporativo, rei e trial.
