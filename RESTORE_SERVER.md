# Restaurar server.ts completo

O arquivo `backend/server.ts` no GitHub ficou só com o cabeçalho Spec Kit
(os limites no comentário já estão corretos).

## Opção rápida (no seu PC, com o repo clonado)

```bash
cd saas-reputacao-ia

# 1) Pegue a versão completa de um commit bom
git show 0beaaa5caee5e61e6788c4ea56f2573b077bcf2b:backend/server.ts > backend/server.ts

# 2) Aplique os limites oficiais (Pro 400, Ultra 800, Corp 3500, Rei 10000)
python3 - <<'PY'
from pathlib import Path
p = Path('backend/server.ts')
t = p.read_text(encoding='utf-8')

old_limits = """    const limits: Record<string, number> = {
      teste: 30,
      pro: 150,
      ultra: 800,
      corporativo: 2500,
      rei: 8000,
    };"""

new_limits = """    const limits: Record<string, number> = {
      teste: 30,
      inicial: 150,
      pro: 400,
      ultra: 800,
      corporativo: 2500,
      rei: 8000,
    };"""

if old_limits in t:
    t = t.replace(old_limits, new_limits)
    print('limits OK')
else:
    print('ATENÇÃO: bloco de limits antigo não encontrado — confira manualmente')

old_pdf = "if (!['ultra', 'corporate', 'corporativo'].includes(empresa.plan))"
new_pdf = "if (!['ultra', 'rei', 'corporate', 'corporativo'].includes(empresa.plan))"
if old_pdf in t:
    t = t.replace(old_pdf, new_pdf)
    print('PDF eligibility OK')

old_spec = """ * /plan (Tabela de Precificação, Limites Globais e Regras de IA)
 * --------------------------------------------------
 * - PLANO PRO MENSAL (R$ 69,90) | ANUAL (R$ 49,90/mês): Limite de 150 avaliações/mês.
 *   Inclui WhatsApp integrado (botão de crise), gráficos visuais básicos e cancelamento sem multa. Sem IA.
 * - PLANO ULTRA (R$ 199,90/mês): Limite de 800 avaliações/mês.
 *   Inclui WhatsApp integrado, DASHBOARD SIMPLES, 1 Relatório Mensal em PDF por IA e respostas personalizadas por IA.
 * - PLANO CORPORATIVO (R$ 499,90/mês): Avaliações ilimitadas.
 *   Inclui WhatsApp integrado, IA sem limites, 1 Relatório Mensal e DASHBOARD COMPLETO Multi-Unidades (Franquias/Filiais)."""

new_spec = """ * /plan (Tabela de Precificação, Limites Globais e Regras de IA)
 * --------------------------------------------------
 * - INICIAL (R$ 69,90/mês | R$ 49,90/mês no anual): 150 feedbacks/mês.
 * - PRO (R$ 109,90/mês | R$ 99,90/mês no anual): 400 feedbacks/mês.
 * - ULTRA (R$ 199,90/mês | R$ 149,90/mês no anual): 800 feedbacks/mês. IA + 1 relatório PDF/mês.
 * - CORPORATIVO (R$ 499,90/mês | R$ 429,90/mês no anual): 2.500 feedbacks/mês. Dashboard multi-unidades.
 * - REI (R$ 999,90/mês | R$ 899,90/mês no anual): 8.000 feedbacks/mês. IA prioritária e relatórios avançados."""

if old_spec in t:
    t = t.replace(old_spec, new_spec)
    print('Spec Kit OK')

p.write_text(t, encoding='utf-8')
print('backend/server.ts atualizado')
PY

git add backend/server.ts
git commit -m "fix: restaura server.ts completo com limites oficiais dos planos"
git push
```

## Limites oficiais (referência)

| Plano | Feedbacks/mês |

| Inicial | 150 |
| Pro | 400 |
| Ultra | 800 |
| Corporativo | 2.500 |
| Rei | 8.000 |
| teste | 30 |
