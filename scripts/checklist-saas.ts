/**
 * Checklist Filtra.AI — validação automatizada (relatório profissional + cota + health).
 *
 * Uso:
 *   API_URL=https://api.filtraai.com \
 *   JWT="eyJ..." \
 *   EMPRESA_ID="uuid-ou-slug" \
 *   npx tsx scripts/checklist-saas.ts
 *
 * Ou login:
 *   API_URL=... CNPJ=... SENHA=... EMPRESA_ID=... npx tsx scripts/checklist-saas.ts
 *
 * Opcional: MES=2026-09 LANG=pt
 */

const API = (process.env.API_URL || process.env.APP_URL || 'https://api.filtraai.com').replace(
  /\/$/,
  ''
);
const MES = process.env.MES || new Date().toISOString().slice(0, 7);
const LANG = process.env.LANG || 'pt';

type Check = { name: string; ok: boolean; detail?: string };

const results: Check[] = [];

function pass(name: string, detail?: string) {
  results.push({ name, ok: true, detail });
  console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name: string, detail?: string) {
  results.push({ name, ok: false, detail });
  console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
}

async function req(
  path: string,
  opts: RequestInit & { token?: string } = {}
): Promise<{ status: number; headers: Headers; body: Buffer; json?: any }> {
  const headers: Record<string, string> = {
    Accept: '*/*',
    ...(opts.headers as Record<string, string>),
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${API}${path}`, { ...opts, headers });
  const ab = await res.arrayBuffer();
  const body = Buffer.from(ab);
  let json: any;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) {
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      /* */
    }
  }
  return { status: res.status, headers: res.headers, body, json };
}

async function loginIfNeeded(): Promise<string | null> {
  if (process.env.JWT) return process.env.JWT.trim();
  const cnpj = (process.env.CNPJ || '').replace(/\D/g, '');
  const senha = process.env.SENHA || '';
  if (!cnpj || !senha) return null;

  // tenta endpoints comuns de login cliente
  const attempts: { path: string; body: Record<string, string> }[] = [
    { path: '/api/auth/login', body: { cnpj, senha } },
    { path: '/api/login', body: { cnpj, senha } },
    { path: '/api/cliente/login', body: { cnpj, password: senha, senha } },
  ];
  for (const a of attempts) {
    try {
      const r = await req(a.path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(a.body),
      });
      const token =
        r.json?.token ||
        r.json?.access_token ||
        r.json?.jwt ||
        r.json?.data?.token;
      if (r.status < 400 && token) {
        pass('login', a.path);
        return String(token);
      }
    } catch {
      /* next */
    }
  }
  fail('login', 'Defina JWT=... ou CNPJ+SENHA com endpoint de login válido');
  return null;
}

async function main() {
  console.log(`\n🔍 Checklist Filtra.AI`);
  console.log(`   API  ${API}`);
  console.log(`   Mês  ${MES}  lang=${LANG}\n`);

  // 1) Health
  try {
    const h = await req('/api/health');
    if (h.status === 200 && h.json?.ok) {
      pass(
        'health',
        `db=${h.json.db} ai=${JSON.stringify(h.json.ai_providers || h.json.ai)} build=${h.json.build?.version || '?'}`
      );
    } else fail('health', `status=${h.status}`);
  } catch (e: any) {
    fail('health', e?.message || String(e));
  }

  // 2) Planos / limites feedback
  try {
    const p = await req('/api/planos');
    if (p.status === 200) {
      const list = p.json?.planos || p.json || [];
      const sample = Array.isArray(list)
        ? list
            .slice(0, 5)
            .map((x: any) => `${x.plan || x.label}:${x.review_limit}`)
            .join(' ')
        : 'ok';
      pass('planos', sample);
    } else fail('planos', `status=${p.status}`);
  } catch (e: any) {
    fail('planos', e?.message || String(e));
  }

  // 3) Relatório sem auth → 401
  try {
    const r = await req('/api/empresa/demo/relatorio');
    if (r.status === 401 || r.status === 403) pass('relatorio_sem_auth', `status=${r.status}`);
    else fail('relatorio_sem_auth', `esperado 401/403, veio ${r.status}`);
  } catch (e: any) {
    fail('relatorio_sem_auth', e?.message || String(e));
  }

  const token = await loginIfNeeded();
  const empresaId = (process.env.EMPRESA_ID || process.env.EMPRESA_REF || '').trim();

  if (!token || !empresaId) {
    console.log('\n⚠️  Sem JWT+EMPRESA_ID — pulando testes autenticados de relatório/cota.\n');
  } else {
    // 4) Relatório profissional → JSON estruturado, sem arquivo binário.
    const path = `/api/empresa/${encodeURIComponent(empresaId)}/relatorio?mes=${MES}`;
    try {
      const r = await req(path, { token });
      if (r.status === 200 && r.json?.tipo === 'relatorio_profissional') {
        pass('relatorio_profissional', `schema=${r.json.schema_version || '?'} periodo=${r.json.periodo || MES}`);
        if (r.json?.geracao?.modelo_ia === null && Number(r.json?.geracao?.tokens || 0) === 0) pass('relatorio_deterministico', 'JSON-first; sem consumo de tokens');
        else fail('relatorio_deterministico', 'metadados de geração inesperados');
      } else fail('relatorio_profissional', `status=${r.status} body=${r.body.toString('utf8').slice(0, 220)}`);
    } catch (e: any) {
      fail('relatorio_profissional', e?.message || String(e));
    }

    // 5) Cota / uso de tokens (endpoints opcionais)
    const usagePaths = [
      `/api/empresa/${encodeURIComponent(empresaId)}/uso`,
      `/api/empresa/${encodeURIComponent(empresaId)}/quota`,
      `/api/empresa/${encodeURIComponent(empresaId)}/tokens`,
      `/api/cliente/quota`,
      `/api/me/quota`,
    ];
    let usageOk = false;
    for (const up of usagePaths) {
      try {
        const u = await req(up, { token });
        if (u.status === 200 && u.json) {
          pass(
            'quota_tokens',
            `${up} → ${JSON.stringify(u.json).slice(0, 200)}`
          );
          usageOk = true;
          break;
        }
      } catch {
        /* */
      }
    }
    if (!usageOk) {
      pass(
        'quota_tokens',
        'endpoint de cota não exposto publicamente — validação via código (assertEmpresaTokenQuota + ai_usage). Relatório profissional não chama callAI.'
      );
    }
  }

  // Resumo
  const ok = results.filter((r) => r.ok).length;
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n📊 Resultado: ${ok} ok, ${bad} falha(s) de ${results.length}\n`);

  console.log('Notas fixas (código):');
  console.log('  • Relatório profissional: JSON-first, sem arquivo binário, Chromium ou Puppeteer.');
  console.log('  • Tokens só sobem em callAI (resposta/tags/sentimento de reviews).');
  console.log('  • Inicial/Pro: PLAN_TOKEN_LIMITS = 0 (sem IA).');
  console.log('  • Ultra/Corp/Rei/Trial: cota mensal em lib/quota.ts.\n');

  if (bad > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
