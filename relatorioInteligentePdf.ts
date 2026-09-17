/**
 * PDF baixável pelo painel — delega ao gerador profissional (relatorioPdf.ts).
 * Garante o mesmo layout do sample: cabeçalho teal, benefícios, KPIs, barras,
 * sentimento/temas por plano, logo Filtra.AI, marca d'água e rodapé de direitos.
 */
import type { Database } from 'sqlite';
import { gerarRelatorioMensalPDF } from './relatorioPdf.js';

function mesFromRange(inicio: string, fim: string): string {
  // Preferir o mês do fim do ciclo (assinatura mensal)
  const end = String(fim || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(end)) return end.slice(0, 7);
  const start = String(inicio || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) return start.slice(0, 7);
  if (/^\d{4}-\d{2}$/.test(end)) return end;
  if (/^\d{4}-\d{2}$/.test(start)) return start;
  return new Date().toISOString().slice(0, 7);
}

export async function gerarRelatorioInteligentePDF(
  db: Database,
  empresaId: string,
  inicio: string,
  fim: string,
  lang = 'pt'
): Promise<Buffer> {
  const mesAno = mesFromRange(inicio, fim);
  return gerarRelatorioMensalPDF(db, empresaId, mesAno, undefined, lang);
}
