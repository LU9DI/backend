# Recuperação de senha + senha no trial

## 1. Instalar dependência de e-mail (opcional em dev)

```bash
cd backend && npm i nodemailer && npm i -D @types/nodemailer
```

Sem SMTP configurado, o link de recuperação **aparece no console** do servidor (modo desenvolvimento).

## 2. Variáveis `.env`

```env
SMTP_HOST=smtp.seuprovedor.com
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM="Filtra.IA <noreply@seudominio.com>"
APP_URL=http://localhost:3000
```

## 3. Encaixe mínimo no `server.ts`

### Imports
```ts
import { mountPasswordResetRoutes, createUsuarioForEmpresa, ensureAuthColumns } from './passwordResetRoutes.js';
```

### Após `await initDB()` no `main()`
```ts
await ensureAuthColumns(db);
mountPasswordResetRoutes(app, () => db);
```

### No trial (`POST /api/trial/ativar`)

Ler também `senha` e `email` do body e, após criar a empresa:

```ts
const senha = String(req.body.senha ?? '');
const email = String(req.body.email ?? '').trim().toLowerCase();
if (senha.length < 6) return res.status(400).json({ error: 'Senha deve ter ao menos 6 caracteres.' });
if (!email) return res.status(400).json({ error: 'E-mail obrigatório.' });

// depois do INSERT em empresas:
await createUsuarioForEmpresa(db, {
  empresaId: id,
  cnpj,
  nome,
  email,
  senha,
});
```

## 4. Rotas

| Método | Rota | Body |
|--------|------|------|
| POST | `/api/auth/forgot-password` | `{ email }` ou `{ cnpj }` |
| POST | `/api/auth/reset-password` | `{ token, nova_senha }` |

Link do e-mail: `{APP_URL}/recuperar-senha?token=...`

## 5. Frontend sugerido

- Campo e-mail + senha no formulário de trial
- Página `/recuperar-senha` e `/login` com link "Esqueci a senha"
