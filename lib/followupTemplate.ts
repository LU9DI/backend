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
    `Vi que a ${nome} está com uma avaliação abaixo do esperado no Google.`,
    '',
    'Isso pode estar impactando a percepção de novos clientes e vale a pena entender o que está por trás dessas avaliações.',
    '',
    'O Filtra.AI ajuda a acompanhar a reputação da empresa, identificar os principais pontos de atenção e entender o que os clientes estão dizendo.',
    '',
    'Você pode testar o Filtra.AI gratuitamente por 7 dias, sem cartão de crédito:',
    url,
    '',
    'Se quiser entender melhor o que está acontecendo com a reputação da sua empresa, é só responder este e-mail.',
    '',
    'Um abraço,',
    'Equipe Filtra.AI',
  ].join('\n');
}
