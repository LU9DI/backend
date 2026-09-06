# Login do painel admin

## Credenciais padrão

| Campo | Valor |

| **URL** | `/admin/login` |
| **E-mail** | `admin@seusaas.com` |
| **Senha** | `MudeEstaSenha123!` (ou o valor de `ADMIN_PASSWORD` no `.env`) |

> A senha só é criada na **primeira** subida do servidor (quando ainda não existe usuário com esse e-mail). Se você já rodou o backend antes com outra senha, use a que estiver no banco ou redefina (veja abaixo).

## Login da empresa (cliente)

| Campo | Valor |

| **URL** | `/login` |
| **CNPJ** | o CNPJ usado no trial |
| **Senha** | a senha cadastrada no trial |

## Problema corrigido

O frontend `/admin/login` chama `POST /api/admin/login` com `{ email, senha }`, mas o backend só tinha `POST /api/auth/login` com `{ cnpj, senha }`.

Foi adicionado o arquivo `adminLoginRoute.ts`.

## Como ligar no server.ts

No `main()` (depois de `initDB` e com `app` + `db` prontos):

```ts
import { mountAdminLoginRoute } from './adminLoginRoute.js';

mountAdminLoginRoute(app, () => db, {
  setAuthCookie,
  JWT_SECRET,
});
```

Reinicie o backend depois de colar isso.

## Resetar senha do admin (SQLite local)

Se a senha padrão não funcionar (usuário já existia):

```bash
cd backend
npx tsx -e "
import bcrypt from 'bcrypt';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
const db = await open({ filename: process.env.SQLITE_DB_PATH || './data/database.sqlite', driver: sqlite3.Database });
const hash = await bcrypt.hash('MudeEstaSenha123!', 10);
const r = await db.run(\"UPDATE usuarios SET senha_hash = ? WHERE email = 'admin@seusaas.com'\", [hash]);
console.log('Atualizados:', r.changes);
await db.close();
"
```

Depois entre em `/admin/login` com:

- e-mail: `admin@seusaas.com`
- senha: `MudeEstaSenha123!`
