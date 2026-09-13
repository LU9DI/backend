import json
import os
import sys
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    KeepTogether, HRFlowable
)

NAVY = colors.HexColor('#07111F')
BLUE = colors.HexColor('#2563EB')
PURPLE = colors.HexColor('#7C3AED')
TEXT = colors.HexColor('#172033')
MUTED = colors.HexColor('#667085')
LIGHT = colors.HexColor('#F5F7FA')
BORDER = colors.HexColor('#E4E7EC')
WHITE = colors.white
GREEN = colors.HexColor('#16A34A')
RED = colors.HexColor('#DC2626')

T = {
    'pt-BR': {
        'title':'Relatório de Análise de Reputação','period':'Período analisado','plan':'Plano',
        'summary':'Resumo executivo','reviews':'Avaliações','average':'Nota média','critical':'Críticas',
        'distribution':'Distribuição das avaliações','sentiment':'Sentimento','themes':'Principais temas',
        'units':'Desempenho por unidade','conclusion':'Conclusão','no_data':'Não houve avaliações válidas no período.',
        'positive':'Positivas','neutral':'Neutras','negative':'Negativas','page':'Página'
    },
    'en-US': {
        'title':'Reputation Analysis Report','period':'Period analyzed','plan':'Plan',
        'summary':'Executive summary','reviews':'Reviews','average':'Average rating','critical':'Critical',
        'distribution':'Review distribution','sentiment':'Sentiment','themes':'Main themes',
        'units':'Performance by unit','conclusion':'Conclusion','no_data':'There were no valid reviews in the selected period.',
        'positive':'Positive','neutral':'Neutral','negative':'Negative','page':'Page'
    },
    'es-ES': {
        'title':'Informe de Análisis de Reputación','period':'Período analizado','plan':'Plan',
        'summary':'Resumen ejecutivo','reviews':'Reseñas','average':'Nota media','critical':'Críticas',
        'distribution':'Distribución de reseñas','sentiment':'Sentimiento','themes':'Temas principales',
        'units':'Rendimiento por unidad','conclusion':'Conclusión','no_data':'No hubo reseñas válidas en el período.',
        'positive':'Positivas','neutral':'Neutrales','negative':'Negativas','page':'Página'
    },
    'zh-CN': {
        'title':'声誉分析报告','period':'分析期间','plan':'方案','summary':'执行摘要',
        'reviews':'评价数量','average':'平均评分','critical':'负面评价','distribution':'评价分布',
        'sentiment':'情感分析','themes':'主要主题','units':'各单位表现','conclusion':'结论',
        'no_data':'所选期间没有有效评价。','positive':'正面','neutral':'中性','negative':'负面','page':'页'
    }
}


def setup_font(lang):
    if lang == 'zh-CN':
        pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
        return 'STSong-Light', 'STSong-Light'
    return 'Helvetica', 'Helvetica-Bold'


def paragraph(text, style):
    return Paragraph(str(text).replace('&', '&amp;'), style)


def page(canvas, doc):
    canvas.saveState()
    w, h = A4
    canvas.setStrokeColor(BORDER)
    canvas.setLineWidth(.5)
    canvas.line(18*mm, h-14*mm, w-18*mm, h-14*mm)
    canvas.setFillColor(NAVY)
    canvas.setFont(doc.font_bold, 9)
    canvas.drawString(18*mm, h-10*mm, 'FILTRA.AI')
    canvas.line(18*mm, 14*mm, w-18*mm, 14*mm)
    canvas.setFillColor(MUTED)
    canvas.setFont(doc.font_regular, 7.5)
    canvas.drawString(18*mm, 9*mm, 'Filtra.AI')
    canvas.drawRightString(w-18*mm, 9*mm, f'{doc.i18n["page"]} {doc.page}')
    canvas.restoreState()


def kpi(label, value, styles):
    t = Table([[paragraph(value, styles['kpi'])],[paragraph(label, styles['small'])]], colWidths=[51*mm], rowHeights=[10*mm,8*mm])
    t.setStyle(TableStyle([
        ('BACKGROUND',(0,0),(-1,-1),WHITE),('BOX',(0,0),(-1,-1),.6,BORDER),
        ('LEFTPADDING',(0,0),(-1,-1),7),('RIGHTPADDING',(0,0),(-1,-1),7),
        ('TOPPADDING',(0,0),(-1,-1),4),('BOTTOMPADDING',(0,0),(-1,-1),2)
    ]))
    return t


def section(title, styles):
    return Paragraph(title, styles['section'])


def simple_table(headers, rows, widths, styles):
    data = [[paragraph(h, styles['th']) for h in headers]]
    data += [[paragraph(v, styles['td']) for v in row] for row in rows]
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([
        ('BACKGROUND',(0,0),(-1,0),NAVY),('TEXTCOLOR',(0,0),(-1,0),WHITE),
        ('GRID',(0,0),(-1,-1),.4,BORDER),('VALIGN',(0,0),(-1,-1),'MIDDLE'),
        ('LEFTPADDING',(0,0),(-1,-1),7),('RIGHTPADDING',(0,0),(-1,-1),7),
        ('TOPPADDING',(0,0),(-1,-1),6),('BOTTOMPADDING',(0,0),(-1,-1),6)
    ]))
    return t


def generate(data, output):
    lang = data.get('language','pt-BR')
    if lang not in T: lang = 'pt-BR'
    i18n = T[lang]
    regular, bold = setup_font(lang)
    styles = {
        'title': ParagraphStyle('title', fontName=bold, fontSize=23, leading=28, textColor=WHITE),
        'cover_small': ParagraphStyle('cover_small', fontName=regular, fontSize=9.5, leading=13, textColor=colors.HexColor('#CBD5E1')),
        'section': ParagraphStyle('section', fontName=bold, fontSize=14, leading=18, textColor=NAVY, spaceBefore=10, spaceAfter=7),
        'body': ParagraphStyle('body', fontName=regular, fontSize=9.5, leading=14, textColor=TEXT, spaceAfter=5),
        'small': ParagraphStyle('small', fontName=regular, fontSize=7.5, leading=10, textColor=MUTED),
        'kpi': ParagraphStyle('kpi', fontName=bold, fontSize=17, leading=20, textColor=NAVY),
        'th': ParagraphStyle('th', fontName=bold, fontSize=8, textColor=WHITE),
        'td': ParagraphStyle('td', fontName=regular, fontSize=8, leading=10, textColor=TEXT),
    }
    doc = SimpleDocTemplate(output, pagesize=A4, rightMargin=18*mm, leftMargin=18*mm, topMargin=22*mm, bottomMargin=19*mm, title=i18n['title'], author='Filtra.AI')
    doc.font_regular = regular
    doc.font_bold = bold
    doc.i18n = i18n
    story=[]

    cover = Table([[paragraph('FILTRA.AI', ParagraphStyle('brand',fontName=bold,fontSize=11,textColor=colors.HexColor('#67E8F9')))],
                   [paragraph(i18n['title'], styles['title'])],
                   [paragraph(data.get('companyName') or 'Empresa', ParagraphStyle('company',fontName=bold,fontSize=16,textColor=WHITE))],
                   [paragraph(f"{i18n['period']}: {data.get('period','—')}", styles['cover_small'])],
                   [paragraph(f"{i18n['plan']}: {data.get('plan','—')}", styles['cover_small'])]],
                  colWidths=[170*mm], rowHeights=[12*mm,25*mm,14*mm,9*mm,9*mm])
    cover.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),NAVY),('LEFTPADDING',(0,0),(-1,-1),14),('RIGHTPADDING',(0,0),(-1,-1),14),('TOPPADDING',(0,0),(-1,-1),8),('BOTTOMPADDING',(0,0),(-1,-1),8)]))
    story += [cover, Spacer(1,10*mm), section(i18n['summary'],styles)]

    k = data.get('kpis') or {}
    cards = Table([[kpi(i18n['reviews'],k.get('reviews',0),styles),kpi(i18n['average'],k.get('average','—'),styles),kpi(i18n['critical'],k.get('critical',0),styles)]], colWidths=[54*mm,54*mm,54*mm])
    cards.setStyle(TableStyle([('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),0),('RIGHTPADDING',(0,0),(-1,-1),4)]))
    story += [cards, Spacer(1,6*mm)]

    if not k.get('reviews'):
        story += [HRFlowable(width='100%',thickness=.6,color=BORDER,spaceAfter=8),paragraph(i18n['no_data'],styles['body'])]
    else:
        dist=data.get('distribution') or {}
        rows=[[i18n['positive'],dist.get('positive',0),dist.get('positivePct','—')],
              [i18n['neutral'],dist.get('neutral',0),dist.get('neutralPct','—')],
              [i18n['negative'],dist.get('negative',0),dist.get('negativePct','—')]]
        story += [section(i18n['distribution'],styles),simple_table([i18n['distribution'],i18n['reviews'],'%'],rows,[95*mm,30*mm,30*mm],styles)]

        if data.get('includeSentiment') and data.get('sentiment'):
            s=data['sentiment']
            story += [section(i18n['sentiment'],styles),simple_table([i18n['positive'],i18n['neutral'],i18n['negative']],[[s.get('positive','—'),s.get('neutral','—'),s.get('negative','—')],[s.get('positivePct','—'),s.get('neutralPct','—'),s.get('negativePct','—')]], [55*mm,55*mm,55*mm],styles)]

        themes=data.get('themes') or []
        if data.get('includeThemes') and themes:
            rows=[[x.get('name',''),x.get('count',0)] for x in themes]
            story += [section(i18n['themes'],styles),simple_table([i18n['themes'],i18n['reviews']],rows,[125*mm,30*mm],styles)]

        units=data.get('units') or []
        if data.get('includeUnits') and units:
            rows=[[x.get('name',''),x.get('reviews',0),x.get('average','—')] for x in units]
            story += [section(i18n['units'],styles),simple_table(['Unidade',i18n['reviews'],i18n['average']],rows,[85*mm,35*mm,35*mm],styles)]

        if data.get('conclusion'):
            story += [section(i18n['conclusion'],styles),paragraph(data['conclusion'],styles['body'])]

    doc.build(story,onFirstPage=page,onLaterPages=page)


def main():
    if len(sys.argv) != 3:
        raise SystemExit('Uso: python relatorioPdf.py input.json output.pdf')
    with open(sys.argv[1],'r',encoding='utf-8') as f: data=json.load(f)
    generate(data,sys.argv[2])
    print(sys.argv[2])

if __name__ == '__main__': main()
