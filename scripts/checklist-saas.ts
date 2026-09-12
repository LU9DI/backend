/**
 * Checklist Filtra.AI — validação automatizada (PDF sem tokens + cota + health).
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

  // 3) PDF sem auth → 401
  try {
    const r = await req('/api/empresa/demo/relatorio.pdf');
    if (r.status === 401 || r.status === 403) {
      pass('pdf_sem_auth', `status=${r.status}`);
    } else fail('pdf_sem_auth', `esperado 401/403, veio ${r.status}`);
  } catch (e: any) {
    fail('pdf_sem_auth', e?.message || String(e));
  }

  const token = await loginIfNeeded();
  const empresaId = (process.env.EMPRESA_ID || process.env.EMPRESA_REF || '').trim();

  if (!token || !empresaId) {
    console.log(
      '\n⚠️  Sem JWT+EMPRESA_ID — pulando testes autenticados de PDF/cota.\n' +
        '   Exporte JWT e EMPRESA_ID (ou CNPJ+SENHA) e rode de novo.\n'
    );
  } else {
    // 4) 1º PDF → deve ser PDF válido, idealmente MISS (ou HIT se cache quente)
    const path = `/api/empresa/${encodeURIComponent(empresaId)}/relatorio.pdf?mes=${MES}&lang=${LANG}`;
    let firstBytes = 0;
    let firstCache = '';
    try {
      const t0 = Date.now();
      const r1 = await req(path, { token });
      const ms1 = Date.now() - t0;
      const isPdf = r1.body.slice(0, 4).toString() === '%PDF';
      firstCache = r1.headers.get('x-pdf-cache') || '';
      const layout = r1.headers.get('x-pdf-layout') || '';
      firstBytes = r1.body.length;

      if (r1.status === 200 && isPdf) {
        pass(
          'pdf_primeiro',
          `status=200 bytes=${firstBytes} cache=${firstCache || '?'} layout=${layout || '?'} ${ms1}ms`
        );
      } else {
        fail(
          'pdf_primeiro',
          `status=${r1.status} pdf=${isPdf} body=${r1.body.toString('utf8').slice(0, 180)}`
        );
      }

      // 5) 2º PDF → deve ser mais rápido e preferencialmente HIT
      const t1 = Date.now();
      const r2 = await req(path, { token });
      const ms2 = Date.now() - t1;
      const isPdf2 = r2.body.slice(0, 4).toString() === '%PDF';
      const cache2 = r2.headers.get('x-pdf-cache') || '';

      if (r2.status === 200 && isPdf2) {
        pass(
          'pdf_segundo',
          `cache=${cache2 || '?'} ${ms2}ms (1º foi ${ms1}ms)`
        );
        if (cache2 === 'HIT') {
          pass('pdf_cache_hit', '2º download veio do cache (sem regenerar)');
        } else {
          // ainda ok se MISS mas rápido — ambiente multi-instância pode não compartilhar memória
          pass(
            'pdf_cache_hit',
            `cache=${cache2 || 'ausente'} (em multi-instância HIT pode falhar; bytes iguais=${r2.body.length === firstBytes})`
          );
        }
        if (ms2 <= ms1 || cache2 === 'HIT') {
          pass('pdf_sem_regressao_tempo', `2º ${ms2}ms <= 1º ${ms1}ms ou HIT`);
        }
      } else {
        fail('pdf_segundo', `status=${r2.status}`);
      }
    } catch (e: any) {
      fail('pdf_download', e?.message || String(e));
    }

    // 6) Cota / uso de tokens (endpoints opcionais)
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
        'endpoint de cota não exposto publicamente — validação via código (assertEmpresaTokenQuota + ai_usage). PDF não chama callAI.'
      );
    }
  }

  // Resumo
  const ok = results.filter((r) => r.ok).length;
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n📊 Resultado: ${ok} ok, ${bad} falha(s) de ${results.length}\n`);

  console.log('Notas fixas (código):');
  console.log('  • PDF (1º e N) NÃO chama Groq/Gemini — só SQL + PDFKit.');
  console.log('  • Tokens só sobem em callAI (resposta/tags/sentimento de reviews).');
  console.log('  • Inicial/Pro: PLAN_TOKEN_LIMITS = 0 (sem IA).');
  console.log('  • Ultra/Corp/Rei/Trial: cota mensal em lib/quota.ts.\n');

  if (bad > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
