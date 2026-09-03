# Finalização — encaixe no server.ts

Aplique **somente** os trechos abaixo no `server.ts` atual. Não apague Spec Kit, IA nem PDF.

---

## A) Imports (após `import 'dotenv/config'`)

```ts
import { mountPasswordResetRoutes, createUsuarioForEmpresa, ensureAuthColumns } from './passwordResetRoutes.js';
import { mountStripeRoutes } from './stripeRoutes.js';
import { stripeConfigured } from './stripeBilling.js';
```

---

## B) Body parser (substituir as duas linhas do express.json / cookieParser)

```ts
const app = express();
app.use(cookieParser());
// JSON em todas as rotas, exceto webhook Stripe (precisa do body cru)
app.use((req, res, next) => {
  if (req.originalUrl?.startsWith('/api/webhook/stripe')) return next();
  return express.json({ limit: '20kb' })(req, res, next);
});
```

---

## C) Substituir o handler inteiro de `POST /api/trial/ativar`

```ts
app.post('/api/trial/ativar', trialLimiter, async (req: Request, res: Response) => {
  try {
    const cnpj = normalizarCnpj(req.body.cnpj ?? '');
    const nome = String(req.body.nome_empresa ?? '').trim().slice(0, 120);
    const googleReviewUrl = String(req.body.google_review_url ?? '').trim().slice(0, 500);
    const email = String(req.body.email ?? '').trim().toLowerCase();
    const senha = String(req.body.senha ?? '');

    if (!cnpjValido(cnpj)) return res.status(400).json({ error: 'CNPJ inválido.' });
    if (nome.length < 2 || nome.length > 120) return res.status(400).json({ error: 'Nome da empresa inválido.' });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'E-mail inválido.' });
    }
    if (senha.length < 6) return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres.' });
    if (googleReviewUrl && !/^https?:\/\//i.test(googleReviewUrl)) {
      return res.status(400).json({ error: 'URL do Google Reviews inválida.' });
    }

    const id = crypto.randomUUID();
    const slug = await slugUnico(slugify(nome));
    const criadoEm = new Date();
    const expiraEm = new Date(criadoEm.getTime() + 7 * 24 * 60 * 60 * 1000);

    try {
      await db.run(
        `INSERT INTO empresas (id, cnpj, nome_empresa, slug, google_review_url, criado_em, expira_em)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, cnpj, nome, slug, googleReviewUrl || null, criadoEm.toISOString(), expiraEm.toISOString()]
      );
    } catch (e: any) {
      if (e.code === 'SQLITE_CONSTRAINT') {
        return res.status(409).json({ error: 'Este CNPJ já ativou o período de testes.' });
      }
      throw e;
    }

    try {
      await createUsuarioForEmpresa(db, {
        empresaId: id,
        cnpj,
        nome,
        email,
        senha,
      });
    } catch (e: any) {
      await db.run('DELETE FROM empresas WHERE id = ?', [id]);
      return res.status(400).json({ error: e.message || 'Falha ao criar usuário.' });
    }

    const links = linksEmpresa(slug);
    res.status(201).json({
      success: true,
      empresa_id: id,
      slug,
      link_acesso: links.avaliacao,
      link_painel: links.painel,
      link_widget: links.widget,
      expira_em: expiraEm.toISOString(),
    });
  } catch (error) {
    console.error('Erro ao ativar trial:', error);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});
```

---

## D) Substituir a função `main`

```ts
async function main() {
  try {
    await initDB();
    await ensureAuthColumns(db);
    mountPasswordResetRoutes(app, () => db);
    mountStripeRoutes(app, () => db);
    console.log(`🔑 Recuperação de senha: on`);
    console.log(`💳 Stripe: ${stripeConfigured() ? 'ok' : 'off (defina STRIPE_SECRET_KEY)'}`);
    app.listen(PORT, () => console.log(`🚀 Servidor em http://localhost:${PORT}`));
  } catch (error) {
    console.error('❌ Falha ao iniciar:', error);
    process.exit(1);
  }
}
```

---

## E) Terminal

```bash
cd backend
npm install
# configure .env (JWT_SECRET, SMTP_*, STRIPE_* se for testar pagamento)
npm run dev
```

## Checklist final

- [ ] Trial pede e-mail + senha e cria usuário
- [ ] Login CNPJ + senha funciona
- [ ] `/recuperar-senha` envia link (console ou SMTP)
- [ ] Planos abrem Stripe Checkout
- [ ] Cancelamento mensal mantém acesso até o fim do ciclo
