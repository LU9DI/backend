#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Filtra.AI — relatório mensal PDF (ReportLab), profundidade por plano."""
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
    KeepTogether,
    PageBreak,
    HRFlowable,
)
from reportlab.graphics.shapes import Drawing, Rect, String, Line
from reportlab.graphics.charts.barcharts import VerticalBarChart
from reportlab.graphics.charts.piecharts import Pie

PAGE_W, PAGE_H = A4
NAVY = colors.HexColor("#0f172a")
INDIGO = colors.HexColor("#4f46e5")
MUTED = colors.HexColor("#64748b")
LINE = colors.HexColor("#e2e8f0")
PALE = colors.HexColor("#f8fafc")
GREEN = colors.HexColor("#16a34a")
RED = colors.HexColor("#dc2626")
AMBER = colors.HexColor("#d97706")
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


def period_label(mes: str) -> str:
    try:
        y, m = mes.split("-")
        return f"{MONTHS_PT[int(m) - 1]} / {y}"
    except Exception:
        return mes


def depth_of(plan: str, trial: bool) -> str:
    if trial:
        return "ultra"
    p = (plan or "").lower()
    if p == "rei":
        return "rei"
    if p in ("corporativo", "corporate"):
        return "corp"
    if p == "ultra":
        return "ultra"
    return "pro"


def make_styles():
    base = getSampleStyleSheet()
    styles = {
        "brand": ParagraphStyle(
            "brand", parent=base["Normal"], fontName="Helvetica-Bold",
            fontSize=22, textColor=NAVY, spaceAfter=4,
        ),
        "h1": ParagraphStyle(
            "h1", parent=base["Normal"], fontName="Helvetica-Bold",
            fontSize=18, textColor=NAVY, spaceAfter=6, leading=22,
        ),
        "h2": ParagraphStyle(
            "h2", parent=base["Normal"], fontName="Helvetica-Bold",
            fontSize=12, textColor=NAVY, spaceBefore=10, spaceAfter=6,
        ),
        "meta": ParagraphStyle(
            "meta", parent=base["Normal"], fontName="Helvetica",
            fontSize=9, textColor=MUTED, leading=12,
        ),
        "body": ParagraphStyle(
            "body", parent=base["Normal"], fontName="Helvetica",
            fontSize=9, textColor=colors.HexColor("#334155"), leading=13,
        ),
        "kpi_label": ParagraphStyle(
            "kpi_label", parent=base["Normal"], fontName="Helvetica-Bold",
            fontSize=7, textColor=MUTED,
        ),
        "kpi_value": ParagraphStyle(
            "kpi_value", parent=base["Normal"], fontName="Helvetica-Bold",
            fontSize=16, textColor=NAVY, spaceBefore=2,
        ),
        "kpi_sub": ParagraphStyle(
            "kpi_sub", parent=base["Normal"], fontName="Helvetica",
            fontSize=7, textColor=MUTED,
        ),
        "footer": ParagraphStyle(
            "footer", parent=base["Normal"], fontName="Helvetica",
            fontSize=7, textColor=MUTED, alignment=1,
        ),
    }
    return styles


def header_footer(canvas, doc, empresa: str, periodo: str, plan_label: str):
    canvas.saveState()
    canvas.setFillColor(NAVY)
    canvas.rect(0, PAGE_H - 22 * mm, PAGE_W, 22 * mm, fill=1, stroke=0)
    canvas.setFillColor(INDIGO)
    canvas.rect(0, PAGE_H - 23 * mm, PAGE_W, 1.2 * mm, fill=1, stroke=0)
    canvas.setFillColor(colors.white)
    canvas.setFont("Helvetica-Bold", 12)
    canvas.drawString(16 * mm, PAGE_H - 12 * mm, "Filtra.AI")
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(colors.HexColor("#c7d2fe"))
    canvas.drawString(16 * mm, PAGE_H - 17 * mm, plan_label)
    canvas.setFillColor(colors.white)
    canvas.setFont("Helvetica", 8)
    canvas.drawRightString(PAGE_W - 16 * mm, PAGE_H - 12 * mm, (empresa or "")[:42])
    canvas.setFillColor(colors.HexColor("#94a3b8"))
    canvas.drawRightString(PAGE_W - 16 * mm, PAGE_H - 17 * mm, periodo)
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.4)
    canvas.line(16 * mm, 12 * mm, PAGE_W - 16 * mm, 12 * mm)
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 7)
    canvas.drawString(16 * mm, 7 * mm, "Filtra.AI · relatório de reputação")
    canvas.drawRightString(PAGE_W - 16 * mm, 7 * mm, f"Página {doc.page}")
    canvas.restoreState()


def kpi_table(styles, items: list[tuple[str, str, str]]):
    cells = []
    for label, value, sub in items:
        block = [
            Paragraph(label.upper(), styles["kpi_label"]),
            Paragraph(value, styles["kpi_value"]),
            Paragraph(sub, styles["kpi_sub"]),
        ]
        cells.append(block)
    data = [cells]
    col = (PAGE_W - 32 * mm) / max(len(items), 1)
    t = Table(data, colWidths=[col] * len(items))
    t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), PALE),
                ("BOX", (0, 0), (-1, -1), 0.5, LINE),
                ("INNERGRID", (0, 0), (-1, -1), 0.4, LINE),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]
        )
    )
    return t


def bar_chart(dist: list[int]) -> Drawing:
    d = Drawing(460, 160)
    chart = VerticalBarChart()
    chart.x = 40
    chart.y = 20
    chart.height = 120
    chart.width = 400
    chart.data = [dist]
    chart.categoryAxis.categoryNames = ["1★", "2★", "3★", "4★", "5★"]
    chart.valueAxis.valueMin = 0
    chart.valueAxis.valueMax = max(max(dist), 1)
    chart.barWidth = 28
    chart.groupSpacing = 12
    chart.bars[0].fillColor = INDIGO
    for i, c in enumerate(STAR):
        try:
            chart.bars[(0, i)].fillColor = c
        except Exception:
            pass
    chart.categoryAxis.labels.fontName = "Helvetica"
    chart.categoryAxis.labels.fontSize = 8
    chart.valueAxis.labels.fontSize = 7
    d.add(chart)
    return d


def pie_sentiment(pos: int, neu: int, neg: int) -> Drawing:
    d = Drawing(220, 140)
    pie = Pie()
    pie.x = 40
    pie.y = 15
    pie.width = 110
    pie.height = 110
    pie.data = [max(pos, 0), max(neu, 0), max(neg, 0)]
    if sum(pie.data) == 0:
        pie.data = [1, 0, 0]
    pie.labels = ["Pos", "Neu", "Neg"]
    pie.slices[0].fillColor = GREEN
    pie.slices[1].fillColor = AMBER
    pie.slices[2].fillColor = RED
    pie.slices.strokeWidth = 0.5
    pie.slices.strokeColor = colors.white
    d.add(pie)
    return d


def build_pdf(payload: dict[str, Any]) -> bytes:
    empresa = str(payload.get("empresa_nome") or "Empresa")
    plan = str(payload.get("plan") or "trial").lower()
    trial = bool(payload.get("trial"))
    mes = str(payload.get("mes") or "")
    periodo = period_label(mes)
    plan_label = "Trial" if trial else str(payload.get("plan_label") or plan.upper())
    depth = depth_of(plan, trial)

    total = int(payload.get("total") or 0)
    avg = float(payload.get("avg") or 0)
    positive = int(payload.get("positive") or 0)
    critical = int(payload.get("critical") or 0)
    dist = list(payload.get("dist") or [0, 0, 0, 0, 0])
    while len(dist) < 5:
        dist.append(0)
    dist = [int(x) for x in dist[:5]]
    sent = payload.get("sentiment") or {"pos": 0, "neu": 0, "neg": 0}
    themes = list(payload.get("themes") or [])
    units = list(payload.get("units") or [])

    styles = make_styles()
    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=16 * mm,
        rightMargin=16 * mm,
        topMargin=28 * mm,
        bottomMargin=18 * mm,
        title=f"{empresa} — {mes}",
        author="Filtra.AI",
    )

    story: list[Any] = []
    story.append(Paragraph("Filtra.AI", styles["brand"]))
    story.append(HRFlowable(width="100%", thickness=2, color=INDIGO, spaceAfter=8))
    story.append(Paragraph(empresa, styles["h1"]))
    story.append(
        Paragraph(
            f"Relatório mensal de reputação · {periodo} · Plano {plan_label}",
            styles["meta"],
        )
    )
    story.append(Spacer(1, 8))

    # KPIs
    story.append(Paragraph("Resumo do período", styles["h2"]))
    story.append(
        kpi_table(
            styles,
            [
                ("Volume", str(total), "Avaliações válidas"),
                ("Nota média", f"{avg:.1f}" if total else "—", "Escala 1 a 5"),
                ("Positivas", f"{positive} ({pct(positive, total)})", "Notas 4–5"),
                ("Críticas", f"{critical} ({pct(critical, total)})", "Notas 1–3"),
            ],
        )
    )

    # Distribution — all plans
    story.append(Paragraph("Distribuição de notas", styles["h2"]))
    story.append(bar_chart(dist))
    story.append(
        Paragraph(
            f"Positivas (4–5★): {positive} ({pct(positive, total)})  ·  "
            f"Críticas (1–3★): {critical} ({pct(critical, total)})",
            styles["body"],
        )
    )

    # Ultra+ sentiment & themes
    if depth in ("ultra", "corp", "rei"):
        story.append(Paragraph("Sentimento", styles["h2"]))
        sent_table = Table(
            [[
                Paragraph(
                    f"<b>Positivo</b><br/>{sent.get('pos', 0)} ({pct(int(sent.get('pos', 0)), total)})",
                    styles["body"],
                ),
                Paragraph(
                    f"<b>Neutro</b><br/>{sent.get('neu', 0)} ({pct(int(sent.get('neu', 0)), total)})",
                    styles["body"],
                ),
                Paragraph(
                    f"<b>Negativo</b><br/>{sent.get('neg', 0)} ({pct(int(sent.get('neg', 0)), total)})",
                    styles["body"],
                ),
            ]],
            colWidths=[(PAGE_W - 32 * mm) / 3] * 3,
        )
        sent_table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, -1), PALE),
                    ("BOX", (0, 0), (-1, -1), 0.5, LINE),
                    ("INNERGRID", (0, 0), (-1, -1), 0.4, LINE),
                    ("LEFTPADDING", (0, 0), (-1, -1), 10),
                    ("TOPPADDING", (0, 0), (-1, -1), 10),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
                ]
            )
        )
        story.append(sent_table)

        if depth == "rei":
            story.append(Spacer(1, 6))
            story.append(pie_sentiment(
                int(sent.get("pos", 0)),
                int(sent.get("neu", 0)),
                int(sent.get("neg", 0)),
            ))

        if themes:
            story.append(Paragraph("Temas da IA", styles["h2"]))
            rows = [["Tema", "Ocorrências"]]
            for th in themes[:10]:
                rows.append([str(th.get("tag") or "")[:48], str(th.get("count") or 0)])
            tt = Table(rows, colWidths=[PAGE_W - 32 * mm - 40 * mm, 40 * mm])
            tt.setStyle(
                TableStyle(
                    [
                        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
                        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                        ("FONTSIZE", (0, 0), (-1, -1), 8),
                        ("BACKGROUND", (0, 1), (-1, -1), PALE),
                        ("GRID", (0, 0), (-1, -1), 0.4, LINE),
                        ("LEFTPADDING", (0, 0), (-1, -1), 6),
                        ("TOPPADDING", (0, 0), (-1, -1), 5),
                        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                    ]
                )
            )
            story.append(tt)

    # Corp / Rei units
    if depth in ("corp", "rei") and units:
        story.append(PageBreak())
        story.append(Paragraph("Ranking de unidades", styles["h2"]))
        rows = [["Unidade", "Volume", "Média", "Críticas"]]
        for u in units:
            rows.append([
                str(u.get("nome") or "Unidade")[:40],
                str(u.get("total") or 0),
                f"{float(u.get('avg') or 0):.1f}",
                str(u.get("critical") or 0),
            ])
        ut = Table(rows, colWidths=[90 * mm, 30 * mm, 30 * mm, 30 * mm])
        ut.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), NAVY),
                    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                    ("FONTSIZE", (0, 0), (-1, -1), 8),
                    ("BACKGROUND", (0, 1), (-1, -1), colors.white),
                    ("GRID", (0, 0), (-1, -1), 0.4, LINE),
                    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PALE]),
                    ("LEFTPADDING", (0, 0), (-1, -1), 6),
                    ("TOPPADDING", (0, 0), (-1, -1), 5),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                ]
            )
        )
        story.append(ut)

        if depth == "rei":
            for u in units[:8]:
                story.append(Spacer(1, 10))
                story.append(
                    Paragraph(
                        f"Unidade: {u.get('nome') or '—'}",
                        styles["h2"],
                    )
                )
                story.append(
                    kpi_table(
                        styles,
                        [
                            ("Volume", str(u.get("total") or 0), "Neste período"),
                            ("Média", f"{float(u.get('avg') or 0):.1f}", "1–5"),
                            ("Críticas", str(u.get("critical") or 0), "1–3★"),
                            (
                                "Positivas",
                                str(u.get("positive") or 0),
                                pct(int(u.get("positive") or 0), int(u.get("total") or 0)),
                            ),
                        ],
                    )
                )

    if total == 0:
        story.append(Spacer(1, 12))
        story.append(
            Paragraph(
                "Nenhuma avaliação válida neste período. "
                "O relatório continua disponível; os números sobem com novos feedbacks.",
                styles["body"],
            )
        )

    story.append(Spacer(1, 16))
    story.append(
        Paragraph(
            "Dados do painel Filtra.AI · sem projeção de resultados futuros.",
            styles["footer"],
        )
    )

    def on_page(c, d):
        header_footer(c, d, empresa, periodo, plan_label)

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
