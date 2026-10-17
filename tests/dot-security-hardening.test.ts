import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function read(path: string) {
  return readFileSync(join(root, path), 'utf8');
}

test('DOT demo mode is opt-in, centralized and never available in production', () => {
  const gate = read('services/dotAccessGate.ts');
  const routes = read('routes/dotRoutes.ts');
  const access = read('routes/dotAccessRoutes.ts');
  const agent = read('routes/dotAgentRoutes.ts');
  const missions = read('routes/dotAgentMissionRoutes.ts');
  // A regra é única (gate) — nenhuma rota mantém cópia própria da decisão.
  assert.match(gate, /DOT_DEMO_MODE\s*===\s*['"]1['"]/);
  assert.match(gate, /NODE_ENV\s*!==\s*['"]production['"]/);
  for (const source of [routes, access, agent, missions]) {
    assert.match(source, /resolveDotGate\(/);
    assert.doesNotMatch(source, /DOT_DEMO_MODE/);
  }
});

test('DOT execution binds permission to authenticated actor', () => {
  const routes = read('routes/dotRoutes.ts');
  const gateway = read('services/dotExecutionGateway.ts');
  assert.match(routes, /executeDotAction\(access\.empresaId, actionId, access\.userId/);
  assert.match(gateway, /actorUserId\?\s*:\s*string \| null/);
  assert.match(gateway, /requireDotAccess\(empresaId, permissionResource, 'execute', actorUserId/);
});

test('approval cannot execute the action inline', () => {
  const routes = read('routes/dotRoutes.ts');
  assert.match(routes, /Aprovar não executa/);
  assert.match(routes, /execution:\s*null/);
});

test('external side effects remain blocked by the execution gateway', () => {
  const gateway = read('services/dotExecutionGateway.ts');
  assert.match(gateway, /definition\.externalSideEffect/);
  assert.match(gateway, /executor homologado pelo gateway/);
});

test('permission changes require an authenticated granting actor and are audited', () => {
  const access = read('routes/dotAccessRoutes.ts');
  const service = read('services/dotAccessControl.ts');
  assert.match(access, /canManagePermissions/);
  assert.match(access, /a\.userId/);
  assert.match(service, /Responsável autenticado é obrigatório/);
  assert.match(service, /permission_granted|permission_revoked/);
});

test('tenant scoping is present on mission and action access paths', () => {
  const missions = read('services/dotAgentMissions.ts');
  const gateway = read('services/dotExecutionGateway.ts');
  assert.match(missions, /WHERE id=\? AND empresa_id=\?/);
  assert.match(gateway, /a\.empresa_id/);
  assert.match(gateway, /d\.empresa_id = a\.empresa_id/);
});

test('DOT agent goal mutations require an authenticated granular actor', () => {
  const routes = read('routes/dotAgentRoutes.ts');
  assert.match(routes, /requireAgentMutation\(res, access, 'operations', 'create'\)/);
  assert.match(routes, /requireAgentMutation\(res, access, 'operations', 'update'\)/);
  assert.match(routes, /Somente um responsável autenticado|Permissão autenticada é necessária/);
  assert.match(routes, /DOT_PERMISSION_REQUIRED/);
});

test('DOT session scope includes tenant and authenticated user identity', () => {
  const routes = read('routes/dotRoutes.ts');
  assert.match(routes, /empresaId.*userScope|userScope.*empresaId/);
  assert.match(routes, /scopedSessionId/);
});

test('DOT execution cannot proceed without an authenticated actor permission', () => {
  const gateway = read('services/dotExecutionGateway.ts');
  assert.match(gateway, /requireDotAccess\(empresaId, permissionResource, 'execute', actorUserId/);
  assert.match(gateway, /Ação externa exige executor homologado pelo gateway/);
  assert.match(gateway, /status = 'approved'/);
});

test('DOT execution audit preserves the authenticated actor', () => {
  const gateway = read('services/dotExecutionGateway.ts');
  const audit = read('services/dotActionAudit.ts');
  assert.match(gateway, /actorType: 'user'/);
  assert.match(gateway, /actorId: actorUserId \|\| null/);
  assert.match(audit, /actor_id TEXT/);
  assert.match(audit, /input\.actorId \|\| null/);
});

test('DOT mission approval is a server-side execution barrier', () => {
  const missions = read('services/dotAgentMissions.ts');
  assert.match(missions, /currentStep\?\.type === 'approval'/);
  assert.match(missions, /approval_action_id/);
  // A barreira exige aprovação registrada (approved_at), não apenas um status.
  assert.match(missions, /approved_at IS NOT NULL/);
  assert.match(missions, /status IN \('approved','executing','executed','failed'\)/);
  assert.match(missions, /Aprovação explícita é obrigatória antes de avançar a missão/);
  // Pausada só volta a andar por retomada explícita.
  assert.match(missions, /Missão pausada: retome a missão explicitamente antes de avançar/);
});
