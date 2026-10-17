import type { Express } from 'express';
import { resolveDotGate } from '../services/dotAccessGate.js';
import { requireDotAccess } from '../services/dotAccessControl.js';
import { createMissionForGoal, listDotAgentMissions, listDotAgentMissionSteps } from '../services/dotAgentMissions.js';
import { advanceMissionManually, resumePausedMission, runCurrentDotMissionStep } from '../services/dotAgentMissionRunner.js';
import { wakeDotAgentWorker } from '../services/dotAgentWorker.js';

// Regra única de entrada no Dot (auth + assinatura/trial + plano Rei/Corporativo).
async function access(req: any) {
  const gate = await resolveDotGate(req);
  return { ok: gate.allowed, empresaId: gate.empresaId, userId: gate.userId, demo: gate.demo, reason: gate.reason };
}

function deny(res: any, a: any) { return res.status(403).json({ ok:false, error:a.reason||'Acesso negado.' }); }

async function requireMissionPermission(a: any, action: 'create' | 'execute') {
  if (!a.userId || a.demo) {
    const error = new Error('Permissão explícita do usuário é necessária para alterar uma missão DOT.');
    (error as any).code = 'DOT_PERMISSION_REQUIRED';
    throw error;
  }
  await requireDotAccess(a.empresaId, 'operations', action, a.userId, { route: 'dot_agent_missions' });
}

export function mountDotAgentMissionRoutes(app: Express) {
  app.get('/api/dot/agent/missions', async (req,res) => {
    const a=await access(req); if(!a.ok || !a.empresaId) return deny(res,a);
    try { res.json({ok:true, missions:await listDotAgentMissions(a.empresaId)}); }
    catch(e){res.status(500).json({ok:false,error:e instanceof Error?e.message:'Falha ao carregar missões.'});}
  });

  app.post('/api/dot/agent/missions', async (req,res) => {
    const a=await access(req); if(!a.ok || !a.empresaId) return deny(res,a);
    const goalId=Number(req.body?.goal_id); const title=String(req.body?.title||'').trim();
    if(!Number.isInteger(goalId)||goalId<=0||title.length<3) return res.status(400).json({ok:false,error:'goal_id e título são obrigatórios.'});
    try {
      await requireMissionPermission(a, 'create');
      const m=await createMissionForGoal(a.empresaId,goalId,title);
      if(!m)return res.status(404).json({ok:false,error:'Objetivo não encontrado.'});
      void wakeDotAgentWorker();
      res.status(201).json({ok:true,mission:m});
    } catch(e){res.status(403).json({ok:false,error:e instanceof Error?e.message:'Falha ao criar missão.'});}
  });

  app.get('/api/dot/agent/missions/:id/steps', async (req,res) => {
    const a=await access(req); if(!a.ok || !a.empresaId) return deny(res,a);
    const id=Number(req.params.id); if(!Number.isInteger(id)||id<=0)return res.status(400).json({ok:false,error:'ID inválido.'});
    try { res.json({ok:true,steps:await listDotAgentMissionSteps(a.empresaId,id)}); }
    catch(e){res.status(500).json({ok:false,error:e instanceof Error?e.message:'Falha ao carregar etapas.'});}
  });

  app.post('/api/dot/agent/missions/:id/run-step', async (req,res) => {
    const a=await access(req); if(!a.ok || !a.empresaId) return deny(res,a);
    const id=Number(req.params.id); if(!Number.isInteger(id)||id<=0)return res.status(400).json({ok:false,error:'ID inválido.'});
    try {
      await requireMissionPermission(a, 'execute');
      const result=await runCurrentDotMissionStep(a.empresaId,id);
      if(!result)return res.status(404).json({ok:false,error:'Missão não encontrada.'});
      res.json({ok:true,...result});
    } catch(e){res.status(403).json({ok:false,error:e instanceof Error?e.message:'Falha ao executar etapa da missão.'});}
  });

  app.post('/api/dot/agent/missions/:id/advance', async (req,res) => {
    const a=await access(req); if(!a.ok || !a.empresaId) return deny(res,a);
    const id=Number(req.params.id); if(!Number.isInteger(id)||id<=0)return res.status(400).json({ok:false,error:'ID inválido.'});
    try {
      await requireMissionPermission(a, 'execute');
      const m=await advanceMissionManually(a.empresaId,id,String(req.body?.output||''));
      if(!m)return res.status(404).json({ok:false,error:'Missão não encontrada.'});
      res.json({ok:true,mission:m});
    } catch(e){res.status(403).json({ok:false,error:e instanceof Error?e.message:'Falha ao avançar missão.'});}
  });

  app.post('/api/dot/agent/missions/:id/resume', async (req,res) => {
    const a=await access(req); if(!a.ok || !a.empresaId) return deny(res,a);
    const id=Number(req.params.id); if(!Number.isInteger(id)||id<=0)return res.status(400).json({ok:false,error:'ID inválido.'});
    try {
      await requireMissionPermission(a, 'execute');
      const result=await resumePausedMission(a.empresaId,id);
      if(!result)return res.status(404).json({ok:false,error:'Missão não encontrada.'});
      if(!result.resumed)return res.status(409).json({ok:false,error:result.reason,mission:result.mission});
      void wakeDotAgentWorker();
      res.json({ok:true,mission:result.mission,reason:result.reason});
    } catch(e){res.status(403).json({ok:false,error:e instanceof Error?e.message:'Falha ao retomar missão.'});}
  });
}
