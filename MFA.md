# MFA (autenticação multifator) — Admin

## O que foi implementado

- **TOTP** (Google Authenticator, Authy, 1Password, etc.)
- **Códigos de backup** (8 códigos de uso único)
- **Segundo passo no login** quando MFA está ativo
- Sem dependência npm extra (RFC 6238 em Node puro)

## Ligar no server.ts

```ts
import { mountAdminLoginRoute } from './adminLoginRoute.js';
import { mountMfaRoutes, ensureMfaColumns } from './mfa.js';

// em initDB:
await ensureMfaColumns(db);

// no main:
mountAdminLoginRoute(app, () => db, { setAuthCookie, JWT_SECRET });
mountMfaRoutes(app, () => db, {
  JWT_SECRET,
  setAuthCookie,
  autenticarToken,
});
```

## Fluxo do usuário

1. Login em `/admin/login` (e-mail + senha) **sem MFA ainda**.
2. Abrir `/admin/mfa` → **Ativar MFA** → escanear QR → confirmar código.
3. Guardar os **códigos de backup**.
4. Próximos logins: senha → código de 6 dígitos → painel.

## Rotas

| Método | Rota | Função |

| POST | `/api/admin/login` | Senha; se MFA on → `mfa_token` |
| POST | `/api/admin/mfa/verify` | Valida TOTP/backup e emite sessão |
| POST | `/api/admin/mfa/setup` | Gera secret (sessão autenticada) |
| POST | `/api/admin/mfa/confirm` | Ativa MFA + backup codes |
| GET | `/api/admin/mfa/status` | `{ enabled }` |
| POST | `/api/admin/mfa/disable` | Desliga MFA |

## Segurança

- Desafio MFA expira em **5 minutos**
- Janela TOTP ±1 período (30s)
- Backup codes hasheados (bcrypt), consumidos ao usar
- Rate limit nas rotas MFA
