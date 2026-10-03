import { getDb, findEmpresa } from '../lib/db.js';

export type DotResolveResult = {
  problem_summary: string;
  verification_status: 'confirmed' | 'unverified' | 'not_found';
  confidence: 'alta' | 'media' | 'baixa';
  facts: Array<{ source: string; fact: string }>;
  evidence: Array<{ id: number; rating: number; comment: string; createdAt?: string }>;
  options: Array<{ id: 'opcao_1' | 'opcao_2'; title: string; description: string; action: string; risk: 'baixo' | 'medio' }>;
  requires_owner_decision: true;
};

function normalize(value: unknown): string {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function terms(message: string): string[] {
  const stop = new Set(['a','o','as','os','um','uma','de','da','do','das','dos','que','e','em','no','na','nos','nas','para','por','com','sem','me','minha','meu','minhas','meus','foi','era','estava','estao','está','isso','isto','esse','essa','cliente','empresa']);
  return normalize(message).split(' ').filter(t => t.length >= 4 && !stop.has(t)).slice(0, 12);
}

export async function resolveDotComplaint(empresaId: string, complaint: string): Promise<DotResolveResult> {
  const cleanComplaint = String(complaint ?? '').trim().slice(0, 1000);
  if (!cleanComplaint) throw new Error('Relato do cliente é obrigatório.');
  const db = getDb();
  const empresa = await findEmpresa(empresaId);
  if (!empresa) throw new Error('Empresa não encontrada.');
  const rows = await db.all('SELECT id, rating, comment, createdAt, is_test FROM reviews WHERE empresa_id = ? ORDER BY createdAt DESC LIMIT 500', [empresaId]);
  const real = (rows || []).filter((r: any) => Number(r.is_test) !== 1);
  const wanted = terms(cleanComplaint);
  const scored = real.map((r: any) => { const text = normalize(r.comment); const matched = wanted.filter(t => text.includes(t)); return { row: r, score: matched.length, matched }; }).filter((x: any) => x.score > 0).sort((a: any, b: any) => b.score - a.score || Number(a.row.rating) - Number(b.row.rating)).slice(0, 5);
  const evidence = scored.map((x: any) => ({ id: Number(x.row.id), rating: Number(x.row.rating), comment: String(x.row.comment || '').slice(0, 500), createdAt: x.row.createdAt ? String(x.row.createdAt) : undefined }));
  const strong = scored.filter((x: any) => x.score >= Math.max(1, Math.ceil(wanted.length * 0.25)));
  const hasCritical = strong.some((x: any) => Number(x.row.rating) <= 3);
  const hasAny = strong.length > 0;
  const verification_status: DotResolveResult['verification_status'] = hasCritical ? 'confirmed' : hasAny ? 'unverified' : 'not_found';
  const confidence: DotResolveResult['confidence'] = hasCritical && strong.length >= 2 ? 'alta' : hasAny ? 'media' : 'baixa';
  const topic = wanted.slice(0, 4).join(', ') || 'o problema relatado';
  const companyName = String((empresa as any).nome_empresa || 'a empresa');
  const companyStatus = String((empresa as any).status || 'desconhecido');
  const facts: DotResolveResult['facts'] = [
    { source: 'cadastro da empresa', fact: 'Caso verificado no contexto da empresa ' + companyName + ', status ' + companyStatus + '.' },
    { source: 'relatos armazenados no Filtra.AI', fact: 'Foram encontradas ' + evidence.length + ' avaliações relacionadas aos termos: ' + topic + '.' },
  ];
  if (hasCritical) facts.push({ source: 'avaliações relacionadas', fact: 'Há pelo menos uma avaliação real com nota de 1 a 3 estrelas relacionada ao relato.' });
  else if (hasAny) facts.push({ source: 'avaliações relacionadas', fact: 'Há avaliações relacionadas ao tema, mas a evidência disponível não confirma por si só a ocorrência do problema.' });
  else facts.push({ source: 'base de avaliações', fact: 'Não foi encontrada evidência textual suficiente nas avaliações disponíveis para confirmar o relato.' });
  const options: DotResolveResult['options'] = hasCritical ? [
    { id: 'opcao_1', title: 'Resolver diretamente', description: 'Tratar o problema identificado e acompanhar novas avaliações para verificar se o sinal diminui.', action: 'priorizar_e_resolver', risk: 'medio' },
    { id: 'opcao_2', title: 'Escalar para responsável', description: 'Enviar o caso para o responsável interno validar causa, contexto operacional e providência.', action: 'escalar_responsavel', risk: 'baixo' },
  ] : [
    { id: 'opcao_1', title: 'Investigar e acompanhar', description: 'Revisar o contexto operacional e monitorar novas avaliações antes de tomar uma ação externa.', action: 'corrigir_e_acompanhar', risk: 'medio' },
    { id: 'opcao_2', title: 'Escalar para responsável', description: 'Pedir validação humana do caso antes de qualquer providência externa.', action: 'escalar_responsavel', risk: 'baixo' },
  ];
  return { problem_summary: cleanComplaint, verification_status, confidence, facts, evidence, options, requires_owner_decision: true };
}