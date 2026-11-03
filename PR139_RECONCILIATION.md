# PR #139 — Reconciliação do snapshot e do trabalho perdido

**Data:** 2026-11-03
**Worktree:** `C:\Users\lucas\backend-pr139-atomicity`
**Branch:** `fix/dot-atomicity-sod`
**HEAD:** `c9e4a897f432202b7e093f079aa82f794f8d48cf`

> Nenhum commit, push, merge ou deploy foi executado.

## 1. Resultado

O snapshot original do commit `c138619` (`fix(dot): execução interna atômica e
separação entre preparador e aprovador`) e o ZIP identificado como
`B3F5…17AA` **não foram recuperados** neste ambiente. Portanto **não é possível
uma reconciliação com o snapshot original**.

O que foi feito foi a reconciliação possível com os artefatos forenses
preservados:

| Artefato | SHA-256 | Conteúdo |
|---|---|---|
| `C:\Users\lucas\Desktop\PR139-forensic.zip` | `375896EB8BA9FF8D355AF0F97DC07E511D21FC2A07EC1B85A1FA0E76B9E599D3` | `pr139.bundle`, patch da worktree, `sha256.csv`, head/branch/status, untracked |
| `C:\Users\lucas\Desktop\backend-pr139-atomicity.zip` | `0554CC510CB5BDB12F0D4D1505DE2CCCCA717CCB8252648F44F113AFEEF1100D` | cópia do worktree |
| `C:\Users\lucas\Desktop\pr139-atomicity-full.bundle` | — | branch `fix/dot-atomicity-sod` em `c9e4a89` |
| `C:\Users\lucas\Desktop\pr139-atomicity.bundle` | — | branch `fix/dot-atomicity-sod` em `c9e4a89` |

Nenhum bundle/zip contém `c138619`; o bundle de preservação mais antigo contém
apenas `510ddc0`, e os bundles novos contêm `c9e4a89`.

## 2. Snapshot forense verificado

O snapshot forense foi extraído apenas para um diretório temporário, sem
alterar o worktree:

```text
head.txt    → c9e4a897f432202b7e093f079aa82f794f8d48cf
branch.txt  → fix/dot-atomicity-sod
untracked   → PR139_PRODUCTION_READINESS_REPORT.md
              PR139_REVIEW_ADDENDUM.md
              docs/DOT_PRODUCTION_READINESS.md
              services/dotActor.ts
```

`services/dotActor.ts` atual tem o mesmo SHA-256 do snapshot forense
(`BDBB131B…EA3122`).

## 3. Diferenças entre o snapshot forense e o estado atual

Comparação pelos hashes do próprio snapshot:

| Arquivo | Snapshot | Atual | Situação |
|---|---|---|---|
| `docs/DOT_PRODUCTION_READINESS.md` | `877F05C1…` | `A22E5072…` | alterado (CSRF/runbook) |
| `PR139_COMPLETION_REPORT.md` | `3C1B23BE…` | `2851E851…` | alterado (números finais) |
| `PR139_PRODUCTION_READINESS_REPORT.md` | `F8B2B8E2…` | `1731748B…` | alterado (relatório final) |
| `PR139_REVIEW_ADDENDUM.md` | `7C27A918…` | `4E1A2FCE…` | alterado (números finais) |
| `routes/dotRoutes.ts` | `4FF2ED2C…` | `586F714E…` | alterado (CSRF dedicado) |
| `tests/dotRouteProtection.test.ts` | `86220446…` | `9EA4B94C…` | alterado (CSRF + spoofing) |

Arquivos adicionados/ajustados depois do snapshot:
`docs/DOT_ACTIVATION_RUNBOOK.md`, `tests/dotMonitorIsTest.test.ts` (hardening de
handles SQLite), `tests/dotRouting.test.ts` (header CSRF) e o próprio relatório
de reconciliação.

Todas as diferenças são rastreáveis às correções desta rodada (dependência,
CSRF, investigação de CI e documentação). Não há evidência de recuperação do
conteúdo original perdido.

## 4. Conclusão

- O trabalho original **não foi recuperado**.
- A entrega atual é uma **reconstrução** sobre `3f584eb`, evoluída até
  `c9e4a89` + alterações não commitadas.
- O snapshot forense permite auditar a evolução, mas não substitui o snapshot
  original.
- Qualquer alegação de que nada do trabalho perdido ficou de fora exigiria o
  snapshot original ou o commit `c138619`; ambos continuam indisponíveis.
