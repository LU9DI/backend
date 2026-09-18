/**
 * Filtra.AI — qualificação automática de leads.
 * Não envia mensagens nem cria contatos: apenas classifica e devolve o evento ao n8n.
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

function safeJson(text: string): any | null {
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    return null;
  }
}

export async function qualifyLead(input: LeadInput): Promise<LeadQualification | null> {
  const system = [
    'Você é o agente de qualificação comercial do Filtra.AI.',
    'Avalie somente sinais fornecidos no lead. Não invente informações.',
    'Não infira dados sensíveis, renda, religião, saúde, política ou características pessoais.',
    'O Filtra.AI ajuda empresas a acompanhar reputação online e avaliações.',
    'Retorne SOMENTE JSON válido no formato:',
    '{"score":0,"qualification":"baixa","reason":"texto curto"}',
    'score deve ser inteiro de 0 a 100.',
    'qualification deve ser alta, media ou baixa.',
    'Considere principalmente clareza de empresa real, presença comercial, fonte do lead e disponibilidade de contato.',
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
    const parsed = safeJson(result.text);
    if (!parsed) return null;

    const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score))));
    const qualification =
      parsed.qualification === 'alta' || parsed.qualification === 'media' || parsed.qualification === 'baixa'
        ? parsed.qualification
        : score >= 70 ? 'alta' : score >= 40 ? 'media' : 'baixa';

    return {
      score,
      qualification,
      reason: String(parsed.reason || 'Lead classificado automaticamente.').slice(0, 500),
    };
  } catch (error: any) {
    console.warn('[lead-automation] qualificação IA indisponível:', error?.message || error);
    return null;
  }
}
