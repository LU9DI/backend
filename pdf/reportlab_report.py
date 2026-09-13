#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Filtra.AI — PDF por plano (simples, visualmente distintos).

Pro   → resumo + distribuição
Ultra → + sentimento + temas IA
Corp  → + ranking de unidades
Rei   → + pizza sentimento + detalhe por unidade + destaques
Trial → mesmo nível Ultra
"""
from __future__ import annotations

import json
import sys
from io import BytesIO
from typing import Any

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    SimpleDocTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
    PageBreak,
    HRFlowable,
    KeepTogether,
)
from reportlab.graphics.shapes import Drawing, Rect, String
from reportlab.graphics.charts.barcharts import VerticalBarChart
from reportlab.graphics.charts.piecharts import Pie

PAGE_W, PAGE_H = A4
NAVY = colors.HexColor("#0f172a")
MUTED = colors.HexColor("#64748b")
LINE = colors.HexColor("#e2e8f0")
PALE = colors.HexColor("#f8fafc")
GREEN = colors.HexColor("#16a34a")
RED = colors.HexColor("#dc2626")
AMBER = colors.HexColor("#d97706")
WHITE = colors.white

PLAN_THEME = {
    "pro": {
        "accent": colors.HexColor("#4f46e5"),
        "title": "Relatório Pro",
        "includes": [
            "Resumo do ciclo (volume, nota, positivas e críticas)",
            "Distribuição de notas 1★ a 5★",
        ],
        "locked": [
            "Sentimento e temas da IA → Ultra+",
            "Ranking de filiais → Corporativo+",
        ],
    },
    "ultra": {
        "accent": colors.HexColor("#0d9488"),
        "title": "Relatório Ultra",
        "includes": [
            "Tudo do Pro",
            "Sentimento (positivo / neutro / negativo)",
            "Principais temas detectados pela IA",
        ],
        "locked": [
            "Ranking de filiais → Corporativo+",
            "Detalhe por unidade → Rei",
        ],
    },
    "corp": {
        "accent": colors.HexColor("#1d4ed8"),
        "title": "Relatório Corporativo",
        "includes": [
            "Tudo do Ultra",
            "Ranking de unidades / filiais",
            "Comparativo de volume e nota por unidade",
        ],
        "locked": [
            "Ficha detalhada por unidade → Rei",
        ],
    },
    "rei": {
        "accent": colors.HexColor("#b45309"),
        "title": "Relatório Rei",
        "includes": [
            "Tudo do Corporativo",
            "Gráfico de sentimento",
            "Ficha de cada unidade",
            "Destaques do ciclo",
        ],
        "locked": [],
    },
}

STAR = [
    colors.HexColor("#ef4444"),
    colors.HexColor("#f97316"),
    colors.HexColor("#eab308"),
    colors.HexColor("#84cc16"),
    colors.HexColor("#22c55e"),
]

MONTHS_PT = [
    "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
    "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
]


def pct(n: int, total: int) -> str:
    return f"{round(n / total * 100)}%" if total else "0%"


def fallback_period_label(mes: str) -> str:
    try:
        y, m = mes.split("-")
        return f"{MONTHS_PT[int(m) - 1]} / {y}"
    except Exception:
        return mes


def resolve_depth(payload: dict[str, Any]) -> str:
    d = str(payload.get("depth") or "").lower().strip()
    if d in ("pro", "ultra", "corp", "rei"):
        return d
    if payload.get("trial"):
        return "ultra"
    p = str(payload.get("plan") or "").lower()
    if p == "rei":
        return "rei"
    if p in ("corporativo", "corporate"):
        return "corp"
    if p in ("ultra", "trial", "teste", "test"):
        return "ultra"
    return "pro"


def make_styles(accent):
    base = getSampleStyleSheet()
    return {
        "brand": ParagraphStyle(
            "brand", parent=base["Normal"], fontName="Helvetica-Bold",
            fontSize=11, textColor=MUTED, spaceAfter=2,
        ),
        "plan_title": ParagraphStyle(
            "plan_title", parent=base["Normal"], fontName="Helvetica-Bold",
            fontSize=18, textColor=NAVY, spaceAfter=4, leading=22,
        ),
        "h1": ParagraphStyle(
            "h1", parent=base["Normal"], fontName="Helvetica-Bold",
            fontSize=16, textColor=NAVY, spaceAfter=4, leading=20,
        ),
        "h2": ParagraphStyle(
            "h2", parent=base["Normal"], fontName="Helvetica-Bold",
            fontSize=11, textColor=NAVY, spaceBefore=12, spaceAfter=6,
        ),
        "meta": ParagraphStyle(
            "meta", parent=base["Normal"], fontName="Helvetica",
            fontSize=9, textColor=MUTED, leading=12, spaceAfter=4,
        ),
        "body": ParagraphStyle(
            "body", parent=base["Normal"], fontName="Helvetica",
            fontSize=9, textColor=colors.HexColor("#334155"), leading=13,
        ),
        "small": ParagraphStyle(
            "small", parent=base["Normal"], fontName="Helvetica",
            fontSize=8, textColor=MUTED, leading=11,
        ),
        "kpi_label": ParagraphStyle(
            "kpi_label", parent=base["Normal"], fontName="Helvetica-Bold",
            fontSize=7, textColor=MUTED,
        ),
        "kpi_value": ParagraphStyle(
            "kpi_value", parent=base["Normal"], fontName="Helvetica-Bold",
            fontSize=15, textColor=NAVY, spaceBefore=2,
        ),
        "kpi_sub": ParagraphStyle(
            "kpi_sub", parent=base["Normal"], fontName="Helvetica",
            fontSize=7, textColor=MUTED,
        ),
        "badge": ParagraphStyle(
            "badge", parent=base["Normal"], fontName="Helvetica-Bold",
            fontSize=9, textColor=WHITE,
        ),
        "footer": ParagraphStyle(
            "footer", parent=base["Normal"], fontName="Helvetica",
            fontSize=7, textColor=MUTED, alignment=1,
        ),
    }


def header_footer(canvas, doc, empresa: str, periodo: str, plan_label: str, accent):
    canvas.saveState()
    canvas.setFillColor(NAVY)
    canvas.rect(0, PAGE_H - 20 * mm, PAGE_W, 20 * mm, fill=1, stroke=0)
    canvas.setFillColor(accent)
    canvas.rect(0, PAGE_H - 21 * mm, PAGE_W, 1.2 * mm, fill=1, stroke=0)
    canvas.setFillColor(WHITE)
    canvas.setFont("Helvetica-Bold", 11)
    canvas.drawString(16 * mm, PAGE_H - 11 * mm, "Filtra.AI")
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(colors.HexColor("#cbd5e1"))
    canvas.drawString(16 * mm, PAGE_H - 16 * mm, plan_label)
    canvas.setFillColor(WHITE)
    canvas.setFont("Helvetica", 8)
    canvas.drawRightString(PAGE_W - 16 * mm, PAGE_H - 11 * mm, (empresa or "")[:40])
    canvas.setFillColor(colors.HexColor("#94a3b8"))
    canvas.drawRightString(PAGE_W - 16 * mm, PAGE_H - 16 * mm, (periodo or "")[:38])
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.4)
    canvas.line(16 * mm, 11 * mm, PAGE_W - 16 * mm, 11 * mm)
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 7)
    canvas.drawString(16 * mm, 6 * mm, f"Plano {plan_label} · ciclo de assinatura")
    canvas.drawRightString(PAGE_W - 16 * mm, 6 * mm, f"Pág. {doc.page}")
    canvas.restoreState()


def kpi_table(styles, items: list[tuple[str, str, str]]):
    cells = []
    for label, value, sub in items:
        cells.append([
            Paragraph(label.upper(), styles["kpi_label"]),
            Paragraph(value, styles["kpi_value"]),
            Paragraph(sub, styles["kpi_sub"]),
        ])
    t = Table([cells], colWidths=[(PAGE_W - 32 * mm) / len(items)] * len(items))
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), PALE),
        ("BOX", (0, 0), (-1, -1), 0.5, LINE),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    return t


def bar_chart(dist: list[int]) -> Drawing:
    d = Drawing(460, 150)
    chart = VerticalBarChart()
    chart.x = 35
    chart.y = 15
    chart.height = 110
    chart.width = 400
    chart.data = [dist]
    chart.categoryAxis.categoryNames = ["1★", "2★", "3★", "4★", "5★"]
    chart.valueAxis.valueMin = 0
    chart.valueAxis.valueMax = max(max(dist), 1)
    chart.barWidth = 26
    chart.groupSpacing = 14
    chart.bars[0].fillColor = colors.HexColor("#4f46e5")
    for i, c in enumerate(STAR):
        try:
            chart.bars[(0, i)].fillColor = c
        except Exception:
            pass
    chart.categoryAxis.labels.fontSize = 8
    chart.valueAxis.labels.fontSize = 7
    d.add(chart)
    return d


def pie_sentiment(pos: int, neu: int, neg: int) -> Drawing:
    d = Drawing(200, 130)
    pie = Pie()
    pie.x = 35
    pie.y = 10
    pie.width = 100
    pie.height = 100
    pie.data = [max(pos, 0), max(neu, 0), max(neg, 0)]
    if sum(pie.data) == 0:
        pie.data = [1, 0, 0]
    pie.labels = ["Pos", "Neu", "Neg"]
    pie.slices[0].fillColor = GREEN
    pie.slices[1].fillColor = AMBER
    pie.slices[2].fillColor = RED
    pie.slices.strokeWidth = 0.5
    pie.slices.strokeColor = WHITE
    d.add(pie)
    return d


def benefits_box(styles, theme: dict, accent) -> Table:
    inc = "<br/>".join(f"• {x}" for x in theme["includes"])
    locked = theme.get("locked") or []
    loc = "<br/>".join(f"• {x}" for x in locked) if locked else "• Relatório completo deste plano"
    left = Paragraph(f"<b>Inclui neste plano</b><br/>{inc}", styles["body"])
    right = Paragraph(f"<b>Só em planos superiores</b><br/>{loc}", styles["small"])
    t = Table([[left, right]], colWidths=[(PAGE_W - 32 * mm) / 2] * 2)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, 0), colors.HexColor("#f0fdf4")),
        ("BACKGROUND", (1, 0), (1, 0), colors.HexColor("#f8fafc")),
        ("BOX", (0, 0), (-1, -1), 0.6, accent),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    return t


def simple_insight(total: int, avg: float, critical: int, positive: int) -> str:
    if total == 0:
        return "Ainda não há avaliações neste ciclo. O relatório já está ativo e preenche sozinho."
    if avg >= 4.5:
        return f"Ciclo forte: média {avg:.1f} com {pct(positive, total)} de notas positivas."
    if avg >= 4.0:
        return f"Bom ciclo: média {avg:.1f}. Há espaço para reduzir as {critical} críticas."
    if avg >= 3.0:
        return f"Ciclo estável (média {avg:.1f}). Priorize as {critical} avaliações críticas."
    return f"Atenção: média {avg:.1f} e {critical} críticas neste ciclo."


def build_pdf(payload: dict[str, Any]) -> bytes:
    empresa = str(payload.get("empresa_nome") or "Empresa")
    plan = str(payload.get("plan") or "trial").lower()
    trial = bool(payload.get("trial"))
    mes = str(payload.get("mes") or "")
    periodo = str(payload.get("period_label") or "").strip() or fallback_period_label(mes)
    plan_label = "Trial" if trial else str(payload.get("plan_label") or plan.upper())
    depth = resolve_depth(payload)
    theme = PLAN_THEME[depth]
    accent = theme["accent"]

    total = int(payload.get("total") or 0)
    avg = float(payload.get("avg") or 0)
    positive = int(payload.get("positive") or 0)
    critical = int(payload.get("critical") or 0)
    dist = [int(x) for x in (list(payload.get("dist") or [0, 0, 0, 0, 0]) + [0, 0, 0, 0, 0])[:5]]
    sent = payload.get("sentiment") or {"pos": 0, "neu": 0, "neg": 0}
    themes = list(payload.get("themes") or [])
    units = list(payload.get("units") or [])

    styles = make_styles(accent)
    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=16 * mm,
        rightMargin=16 * mm,
        topMargin=26 * mm,
        bottomMargin=16 * mm,
        title=f"{theme['title']} — {empresa}",
        author="Filtra.AI",
        subject=f"depth={depth}",
    )

    story: list[Any] = []

    # —— capa / identidade do plano ——
    story.append(Paragraph("Filtra.AI", styles["brand"]))
    story.append(Paragraph(theme["title"], styles["plan_title"]))
    story.append(Paragraph(empresa, styles["h1"]))
    story.append(Paragraph(
        f"Ciclo · {periodo} &nbsp;&nbsp;|&nbsp;&nbsp; Plano <b>{plan_label}</b>",
        styles["meta"],
    ))
    story.append(Spacer(1, 4))
    story.append(benefits_box(styles, theme, accent))
    story.append(Spacer(1, 8))
    story.append(Paragraph(
        f"<b>Leitura rápida:</b> {simple_insight(total, avg, critical, positive)}",
        styles["body"],
    ))

    # —— Pro+ base ——
    story.append(Paragraph("1. Resumo do ciclo", styles["h2"]))
    story.append(kpi_table(styles, [
        ("Volume", str(total), "Avaliações válidas"),
        ("Nota média", f"{avg:.1f}" if total else "—", "De 1 a 5"),
        ("Positivas", f"{positive}", pct(positive, total)),
        ("Críticas", f"{critical}", pct(critical, total)),
    ]))

    story.append(Paragraph("2. Distribuição de notas", styles["h2"]))
    story.append(bar_chart(dist))

    # —— Ultra+ ——
    if depth in ("ultra", "corp", "rei"):
        story.append(Paragraph("3. Sentimento", styles["h2"]))
        sent_row = Table([[
            Paragraph(f"<b>Positivo</b><br/>{sent.get('pos', 0)} ({pct(int(sent.get('pos', 0)), total)})", styles["body"]),
            Paragraph(f"<b>Neutro</b><br/>{sent.get('neu', 0)} ({pct(int(sent.get('neu', 0)), total)})", styles["body"]),
            Paragraph(f"<b>Negativo</b><br/>{sent.get('neg', 0)} ({pct(int(sent.get('neg', 0)), total)})", styles["body"]),
        ]], colWidths=[(PAGE_W - 32 * mm) / 3] * 3)
        sent_row.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), PALE),
            ("BOX", (0, 0), (-1, -1), 0.5, LINE),
            ("INNERGRID", (0, 0), (-1, -1), 0.4, LINE),
            ("LEFTPADDING", (0, 0), (-1, -1), 8),
            ("TOPPADDING", (0, 0), (-1, -1), 8),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ]))
        story.append(sent_row)

        if depth == "rei":
            story.append(Spacer(1, 6))
            story.append(pie_sentiment(
                int(sent.get("pos", 0)),
                int(sent.get("neu", 0)),
                int(sent.get("neg", 0)),
            ))

        story.append(Paragraph("4. Temas da IA", styles["h2"]))
        if themes:
            rows = [["Tema", "Qtd"]]
            for th in themes[:8]:
                rows.append([str(th.get("tag") or "")[:50], str(th.get("count") or 0)])
            tt = Table(rows, colWidths=[PAGE_W - 32 * mm - 28 * mm, 28 * mm])
            tt.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), accent),
                ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 8),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, PALE]),
                ("GRID", (0, 0), (-1, -1), 0.4, LINE),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]))
            story.append(tt)
        else:
            story.append(Paragraph(
                "Nenhum tema de IA neste ciclo (ainda sem tags ou volume baixo).",
                styles["small"],
            ))
    else:
        # Pro: deixa explícito o que falta
        story.append(Paragraph("3. Análise avançada", styles["h2"]))
        story.append(Paragraph(
            "No plano <b>Pro</b> você vê volume, nota e distribuição. "
            "Sentimento, temas da IA e filiais entram nos planos <b>Ultra</b>, "
            "<b>Corporativo</b> e <b>Rei</b>.",
            styles["body"],
        ))

    # —— Corp+ unidades ——
    if depth in ("corp", "rei"):
        story.append(PageBreak())
        story.append(Paragraph("5. Ranking de unidades", styles["h2"]))
        if units:
            rows = [["#", "Unidade", "Volume", "Média", "Críticas"]]
            for i, u in enumerate(units, 1):
                rows.append([
                    str(i),
                    str(u.get("nome") or "Unidade")[:36],
                    str(u.get("total") or 0),
                    f"{float(u.get('avg') or 0):.1f}",
                    str(u.get("critical") or 0),
                ])
            ut = Table(rows, colWidths=[12 * mm, 80 * mm, 28 * mm, 28 * mm, 28 * mm])
            ut.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), accent),
                ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 8),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, PALE]),
                ("GRID", (0, 0), (-1, -1), 0.4, LINE),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]))
            story.append(ut)
        else:
            story.append(Paragraph(
                "Nenhuma unidade com avaliações neste ciclo. Cadastre filiais no painel para ver o ranking.",
                styles["body"],
            ))

        if depth == "rei" and units:
            story.append(Paragraph("6. Ficha por unidade", styles["h2"]))
            for u in units[:8]:
                block = [
                    Paragraph(f"<b>{u.get('nome') or 'Unidade'}</b>", styles["body"]),
                    kpi_table(styles, [
                        ("Volume", str(u.get("total") or 0), "Ciclo"),
                        ("Média", f"{float(u.get('avg') or 0):.1f}", "1–5"),
                        ("Críticas", str(u.get("critical") or 0), "1–3★"),
                        ("Positivas", str(u.get("positive") or 0),
                         pct(int(u.get("positive") or 0), int(u.get("total") or 0))),
                    ]),
                    Spacer(1, 8),
                ]
                story.append(KeepTogether(block))

            # Destaques Rei
            story.append(Paragraph("7. Destaques do ciclo", styles["h2"]))
            best = max(units, key=lambda x: (float(x.get("avg") or 0), int(x.get("total") or 0)))
            worst = min(units, key=lambda x: (float(x.get("avg") or 5), -int(x.get("total") or 0)))
            story.append(Paragraph(
                f"• Melhor média: <b>{best.get('nome')}</b> ({float(best.get('avg') or 0):.1f})<br/>"
                f"• Atenção: <b>{worst.get('nome')}</b> ({float(worst.get('avg') or 0):.1f})<br/>"
                f"• Críticas totais no ciclo: <b>{critical}</b>",
                styles["body"],
            ))

    if total == 0:
        story.append(Spacer(1, 10))
        story.append(Paragraph(
            "Sem avaliações válidas neste ciclo — o PDF continua disponível e se atualiza com novos feedbacks.",
            styles["small"],
        ))

    story.append(Spacer(1, 14))
    story.append(Paragraph(
        f"Filtra.AI · {theme['title']} · dados do painel · sem projeção futura",
        styles["footer"],
    ))

    def on_page(c, d):
        header_footer(c, d, empresa, periodo, plan_label, accent)

    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
    return buf.getvalue()


def main() -> int:
    raw = sys.stdin.buffer.read()
    if not raw:
        print("empty stdin", file=sys.stderr)
        return 2
    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception as e:
        print(f"invalid json: {e}", file=sys.stderr)
        return 2
    try:
        pdf = build_pdf(payload)
    except Exception as e:
        print(f"build failed: {e}", file=sys.stderr)
        return 1
    sys.stdout.buffer.write(pdf)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
