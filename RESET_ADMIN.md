# Login admin — guia definitivo

## Credenciais

| Campo | Valor |

| **URL** | `/admin/login` |
| **E-mail** | `admin@seusaas.com` |
| **Senha** | `MudeEstaSenha123!` |

Se no arquivo `.env` existir `ADMIN_PASSWORD=alguma-coisa`, use **esse** valor como senha.

---

## Por que o login falha

1. A tela `/admin/login` chama `POST /api/admin/login` com **e-mail + senha**.
2. Sem essa rota no backend, a API responde 404 → “Erro de conexão” ou falha no front.
3. Se a rota existe mas a senha no banco é outra → 401 Credenciais inválidas.

---

## Correção em 3 passos (no seu PC)

### 1) Cole esta rota no `server.ts`

Procure `app.post('/api/admin/logout'` e **antes** dela cole:

```ts
app.post('/api/admin/login', loginLimiter, async (req: Request, res: Response) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const senha = String(req.body.senha || '');
    if (!email || !senha) {
      return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
    }
    const usuario = await db.get('SELECT * FROM usuarios WHERE email = ?', [email]);
    if (!usuario || !usuario.senha_hash) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }
    const isAdmin =
      usuario.empresa_id === 'admin' ||
      String(usuario.email || '').toLowerCase() === 'admin@seusaas.com';
    if (!isAdmin) {
      return res.status(403).json({ error: 'Acesso restrito ao painel administrativo.' });
    }
    const ok = await bcrypt.compare(senha, usuario.senha_hash);
    if (!ok) return res.status(401).json({ error: 'Credenciais inválidas.' });

    const token = jwt.sign(
      {
        id: usuario.id,
        nome_funcionario: usuario.nome_funcionario,
        empresa_id: usuario.empresa_id,
        role: 'admin',
      },
      JWT_SECRET,
      { expiresIn: '1d' }
    );
    setAuthCookie(res, token);
    res.json({
      success: true,
      tokenPayload: {
        id: usuario.id,
        nome_funcionario: usuario.nome_funcionario,
        empresa_id: usuario.empresa_id,
        role: 'admin',
      },
    });
  } catch (error) {
    console.error('Erro no admin login:', error);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});
```

(Ou use o arquivo `adminLoginRoute.ts` já no repositório com `mountAdminLoginRoute`.)

### 2) Resetar senha do admin no banco

```bash
cd backend
npx tsx -e "
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';

const path = process.env.SQLITE_DB_PATH || './data/database.sqlite';
const db = await open({ filename: path, driver: sqlite3.Database });
const hash = await bcrypt.hash('MudeEstaSenha123!', 10);
const u = await db.get(\"SELECT id FROM usuarios WHERE email = 'admin@seusaas.com'\");
if (!u) {
  await db.run(
    'INSERT INTO usuarios (id, cnpj, nome_funcionario, empresa_id, senha_hash, email) VALUES (?, ?, ?, ?, ?, ?)',
    [crypto.randomUUID(), '00000000000000', 'Admin', 'admin', hash, 'admin@seusaas.com']
  );
  console.log('Admin criado');
} else {
  await db.run(\"UPDATE usuarios SET senha_hash = ? WHERE email = 'admin@seusaas.com'\", [hash]);
  console.log('Senha resetada');
}
await db.close();
"
```

### 3) Reiniciar o backend e testar

```bash
# reinicie o processo do backend (npm run dev / tsx server.ts)

curl -i -X POST http://localhost:5000/api/admin/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@seusaas.com","senha":"MudeEstaSenha123!"}'
```

- **200** + cookie → abra `/admin/login` e entre  
- **404** → rota ainda não está no `server.ts` que está rodando  
- **401** → rode o reset de senha de novo  
- **Failed to fetch** → `NEXT_PUBLIC_API_URL` no frontend aponta para a URL errada, ou o backend está offline

---

## Login de empresa (não é o admin)

| Campo | Valor |

| URL | `/login` |
| CNPJ | o do trial |
| Senha | a cadastrada no trial |
