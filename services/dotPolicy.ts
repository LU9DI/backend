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

  // Autonomia nunca remove a aprovação de ações externas. Até existir
  // executor externo registrado, o Dot também não executa efeitos externos.
  const executeAutomatically =
    preferences.autonomy === 'autonomo_controlado' &&
    risk === 'low' &&
    !preferences.requireApprovalForExternalActions;

  return {
    autonomy: preferences.autonomy,
    observe,
    createDecision,
    prepareAction: canPrepare,
    executeAutomatically,
    requiresApproval: preferences.requireApprovalForExternalActions || risk !== 'low',
  };
}
