export type DotActionRisk = 'baixo' | 'medio' | 'alto';
export type DotActionChannel = 'internal' | 'whatsapp' | 'google_reviews' | 'crm' | 'email';

export type DotActionDefinition = {
  action: string;
  category: 'reputacao' | 'escalacao' | 'acompanhamento' | 'mensageria' | 'crm';
  risk: DotActionRisk;
  channels: DotActionChannel[];
  requiresApproval: boolean;
  allowedAutonomy: Array<'observador' | 'assistente' | 'proativo' | 'autonomo_controlado'>;
  externalSideEffect: boolean;
  executorKey: string;
  timeoutMs: number;
  maxRetries: number;
};

const registry: Record<string, DotActionDefinition> = {
  priorizar_e_resolver: {
    action: 'priorizar_e_resolver',
    category: 'reputacao',
    risk: 'medio',
    channels: ['internal'],
    requiresApproval: true,
    allowedAutonomy: ['assistente', 'proativo', 'autonomo_controlado'],
    externalSideEffect: false,
    executorKey: 'local.priorizar_e_resolver',
    timeoutMs: 10_000,
    maxRetries: 1,
  },
  escalar_responsavel: {
    action: 'escalar_responsavel',
    category: 'escalacao',
    risk: 'baixo',
    channels: ['internal'],
    requiresApproval: true,
    allowedAutonomy: ['assistente', 'proativo', 'autonomo_controlado'],
    externalSideEffect: false,
    executorKey: 'local.escalar_responsavel',
    timeoutMs: 10_000,
    maxRetries: 1,
  },
  corrigir_e_acompanhar: {
    action: 'corrigir_e_acompanhar',
    category: 'acompanhamento',
    risk: 'medio',
    channels: ['internal'],
    requiresApproval: true,
    allowedAutonomy: ['assistente', 'proativo', 'autonomo_controlado'],
    externalSideEffect: false,
    executorKey: 'local.corrigir_e_acompanhar',
    timeoutMs: 10_000,
    maxRetries: 1,
  },
};

export function getDotActionDefinition(action: string): DotActionDefinition | null {
  return registry[action] || null;
}

export function isDotActionAllowed(action: string, autonomy: DotActionDefinition['allowedAutonomy'][number]): boolean {
  const definition = getDotActionDefinition(action);
  return Boolean(definition && definition.allowedAutonomy.includes(autonomy));
}

export function dotActionRequiresApproval(action: string): boolean {
  return getDotActionDefinition(action)?.requiresApproval ?? true;
}

export function listDotActionDefinitions(): DotActionDefinition[] {
  return Object.values(registry);
}
