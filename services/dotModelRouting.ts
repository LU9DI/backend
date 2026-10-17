import {
  defaultModelFor,
  listAiProviders,
  modelSupportsProvider,
  type AiProvider,
} from '../groqService.js';

/**
 * Roteamento de modelo do Filtra Dot.
 *
 * O roteamento escolhe um *tier* de profundidade a partir da intenção da
 * mensagem e devolve o modelo configurado para aquele tier. O modelo devolvido
 * é sempre um modelo real e válido para o provedor primário configurado — nunca
 * um identificador inventado. Se o `callAI` fizer failover para o outro
 * provedor, o próprio `callAI` recusa um modelo que não pertence àquele
 * provedor e usa o padrão dele, reportando o modelo realmente usado.
 *
 * Configuração por variáveis de ambiente (todas opcionais):
 *   DOT_MODEL_DEEP      modelo para perguntas analíticas
 *   DOT_MODEL_STANDARD  modelo para perguntas gerais
 *   DOT_MODEL_FAST      modelo para consultas factuais curtas
 *   DOT_MODEL           fallback para qualquer tier
 */

export type DotModelTier = 'deep' | 'standard' | 'fast';

export type DotModelRouting = {
  tier: DotModelTier;
  model: string;
  provider: AiProvider;
  reason: string;
};

// Termos (já normalizados) que exigem raciocínio mais profundo.
const DEEP_HINTS = [
  'por que', 'porque', 'causa', 'impacto', 'comparar', 'comparacao', 'compare',
  'estrategia', 'plano', 'planejar', 'analisar', 'analise', 'explicar', 'explique',
  'tendencia', 'risco', 'previsao', 'recomendacao', 'recomende', 'decisao',
  'cenario', 'priorizar', 'prioridade', 'melhorar', 'reduzir', 'aumentar', 'como ',
];

// Termos que indicam consulta factual curta.
const FAST_HINTS = [
  'media', 'quantas', 'quantos', 'total', 'quando', 'nota', 'status', 'resumo',
  'listar', 'liste', 'qual o', 'qual a',
];

function normalize(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function detectTier(message: string): DotModelTier {
  const text = normalize(message);
  if (DEEP_HINTS.some((hint) => text.includes(hint))) return 'deep';
  if (FAST_HINTS.some((hint) => text.includes(hint))) return 'fast';
  return 'standard';
}

function envModel(key: string, provider: AiProvider): string | null {
  const value = String(process.env[key] || '').trim();
  if (!value) return null;
  // Um modelo de outro provedor não pode ser anunciado como escolha deste provedor.
  return modelSupportsProvider(provider, value) ? value : null;
}

function primaryProvider(): AiProvider {
  const providers = listAiProviders();
  return providers.length ? providers[0] : 'groq';
}

const TIER_ENV: Record<DotModelTier, string> = {
  deep: 'DOT_MODEL_DEEP',
  standard: 'DOT_MODEL_STANDARD',
  fast: 'DOT_MODEL_FAST',
};

const TIER_REASON: Record<DotModelTier, string> = {
  deep: 'Pergunta analítica: exige raciocínio sobre causa, impacto ou recomendação.',
  standard: 'Pergunta geral: profundidade padrão do agente.',
  fast: 'Consulta factual curta: resposta objetiva com o menor custo.',
};

export function selectDotModel(message: string): DotModelRouting {
  const provider = primaryProvider();
  const tier = detectTier(message);
  const configured =
    envModel(TIER_ENV[tier], provider) ||
    envModel('DOT_MODEL', provider) ||
    defaultModelFor(provider);

  return {
    tier,
    model: configured,
    provider,
    reason: TIER_REASON[tier],
  };
}
