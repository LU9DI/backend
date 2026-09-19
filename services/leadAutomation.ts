/**
 * Qualificação automática de leads do Filtra.AI.
 * Apenas classifica o lead; não envia mensagens nem altera CRM.
 */
import { callAI } from '../groqService.js';

export type LeadInput = {
  nome_empresa?: string;
  email?: string;
  telefone?: string;
  fonte?: string;
  maps_url?: string;
};

export type LeadQualification = {
  score: number;
  qualification: 'alta' | 'media' | 'baixa';
  reason: string;
};

function parseJson(text: string): any | null {
  try { return JSON.parse(text.replace(/```json|```/g, '').trim()); } catch { return null; }
}

export async function qualifyLead(input: LeadInput): Promise<LeadQualification | null> {
  const system = [
    'Você é o agente de qualificação comercial do Filtra.AI.',
    'Use somente os sinais fornecidos; não invente informações.',
    'Não infira dados sensíveis ou características pessoais.',
    'O Filtra.AI ajuda empresas a acompanhar reputação online e avaliações.',
    'Retorne SOMENTE JSON válido: {"score":0,"qualification":"baixa","reason":"texto curto"}.',
    'score é inteiro de 0 a 100; qualification é alta, media ou baixa.',
    'Considere presença comercial, clareza da empresa, fonte e disponibilidade de contato.'
  ].join(' ');
  const user = JSON.stringify({
    empresa: input.nome_empresa || null,
    email: input.email || null,
    telefone: input.telefone || null,
    fonte: input.fonte || null,
    google_maps_url: input.maps_url || null,
  });
  try {
    const result = await callAI(system, user, 140, 0.2, { tipo: 'qualificacao_lead' });
    const parsed = parseJson(result.text);
    if (!parsed) return null;
    const raw = Number(parsed.score);
    const score = Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : 0;
    const qualification = parsed.qualification === 'alta' || parsed.qualification === 'media' || parsed.qualification === 'baixa'
      ? parsed.qualification : score >= 70 ? 'alta' : score >= 40 ? 'media' : 'baixa';
    return { score, qualification, reason: String(parsed.reason || 'Lead classificado automaticamente.').slice(0, 500) };
  } catch (error: any) {
    console.warn('[lead-automation] qualificação IA indisponível:', error?.message || error);
    return null;
  }
}
