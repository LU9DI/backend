/**
 * Template fixo de follow-up comercial do Filtra.AI.
 *
 * A redação fica centralizada no backend para que o n8n não seja
 * a fonte de verdade do texto enviado ao lead.
 */

function appUrl(): string {
  return (
    process.env.APP_URL ||
    process.env.FRONTEND_URL ||
    'https://filtraai.com'
  ).trim().replace(/\/$/, '');
}

export function buildFollowupDraft(nomeEmpresa?: string | null): string {
  const nome = String(nomeEmpresa || '').trim() || 'sua empresa';
  const url = appUrl();

  return [
    'Olá, tudo bem?',
    '',
    `Vi que ${nome} demonstrou interesse no Filtra.AI.`,
    '',
    'O Filtra.AI ajuda empresas a acompanhar sua reputação, entender o que os clientes estão dizendo e identificar rapidamente pontos que merecem atenção.',
    '',
    'Se quiser conhecer a plataforma e ver como funciona, é só acessar:',
    url,
    '',
    'Se tiver alguma dúvida, é só responder este e-mail. Será um prazer ajudar.',
    '',
    'Um abraço,',
    'Equipe Filtra.AI',
  ].join('\n');
}
