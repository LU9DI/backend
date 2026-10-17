import type { DotPreferences } from './dotPreferences.js';

export type DotRisk = 'low' | 'medium' | 'high' | 'critical';

export type DotPolicyDecision = {
  autonomy: DotPreferences['autonomy'];
  observe: boolean;
  createDecision: boolean;
  prepareAction: boolean;
  executeAutomatically: boolean;
  requiresApproval: boolean;
};

export function evaluateDotPolicy(
  preferences: DotPreferences,
  risk: DotRisk = 'medium',
): DotPolicyDecision {
  const observe = true;
  const createDecision = preferences.autonomy !== 'observador' || preferences.immediateAlerts;
  const canPrepare =
    preferences.prepareActionsAutomatically &&
    preferences.autonomy !== 'observador';

  // A autonomia do agente nunca transforma uma ação preparada em execução
  // implícita. Aprovação explícita continua sendo obrigatória no gateway.
  const executeAutomatically = false;

  return {
    autonomy: preferences.autonomy,
    observe,
    createDecision,
    prepareAction: canPrepare,
    executeAutomatically,
    requiresApproval: true,
  };
}
