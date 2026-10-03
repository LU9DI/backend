export type DotActionProposal = {
  type: 'reputation_improvement' | 'custom';
  title: string;
  objective: string;
  steps: string[];
  requiresApproval: true;
  executed: false;
  demo: boolean;
};

export function prepareDotAction(action: string, demo = true): DotActionProposal {
  const normalized = action.trim().toLowerCase();
  const known = normalized.includes('tempo') || normalized.includes('espera') || normalized.includes('equipe');

  if (known) {
    return {
      type: 'reputation_improvement',
      title: 'Plano para reduzir reclamações sobre tempo de espera',
      objective: 'Investigar as avaliações afetadas, identificar o ponto operacional recorrente e preparar uma orientação para a equipe.',
      steps: [
        'Separar as avaliações recentes que citam tempo de espera.',
        'Agrupar os motivos recorrentes por etapa do atendimento.',
        'Preparar uma ação para a equipe e uma resposta padrão para aprovação.',
      ],
      requiresApproval: true,
      executed: false,
      demo,
    };
  }

  return {
    type: 'custom',
    title: 'Ação preparada pelo Filtra Dot',
    objective: action.trim().slice(0, 500),
    steps: [
      'Validar os dados envolvidos.',
      'Preparar a execução.',
      'Solicitar aprovação antes de qualquer ação externa.',
    ],
    requiresApproval: true,
    executed: false,
    demo: true,
  };
}
