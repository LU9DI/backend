# JWT rotation + WebAuthn (digital)

## Rotação de JWT

```env
JWT_SECRET=chave_atual_forte
JWT_SECRET_PREVIOUS=chave_anterior_ainda_valida
JWT_KID=v2
JWT_EXPIRES=1d
# opcional: JWT_SECRETS=chave3,chave4
```

### Como rotacionar em produção

1. `JWT_SECRET_PREVIOUS=<valor atual de JWT_SECRET>`
2. Gere novo segredo (ex: `openssl rand -base64 48`)
3. `JWT_SECRET=<novo>` e `JWT_KID=v3`
4. Reinicie a API
5. Tokens antigos continuam válidos até expirar; novos usam a chave nova

Health: `GET /api/health` → `jwt.keys_for_verify`

## Login com digital (WebAuthn)

A **impressão digital / Face ID nunca sai do aparelho**. O servidor só valida assinatura criptográfica.

```env
WEBAUTHN_RP_ID=localhost
WEBAUTHN_RP_NAME=Filtra.IA
WEBAUTHN_ORIGIN=http://localhost:3000
WEBAUTHN_MAX_CREDENTIALS=5
```

Em produção: `WEBAUTHN_RP_ID=seudominio.com` e `WEBAUTHN_ORIGIN=https://seudominio.com` (HTTPS obrigatório).

### Fluxo

1. Usuário entra com **senha** uma vez
2. Com JWT válido, chama registro:
   - `POST /api/webauthn/register/options`
   - `navigator.credentials.create`
   - `POST /api/webauthn/register/verify`
3. Depois: na tela `/login`, CNPJ + **Entrar com digital**

### Proteções

| Controle | Detalhe |
|----------|---------|
| Challenge uso único | TTL 5 min, apagado ao consumir |
| Origin binding | clientData.origin deve bater com WEBAUTHN_ORIGIN |
| RP ID hash | anti-phishing |
| userVerification required | exige biometria, não só toque |
| Contador | rejeita se counter não aumentar (clone) |
| Rate limit | 40 req / 15 min |
| Máx. credentials | 5 por usuário |

### API

- `GET /api/webauthn/config`
- `POST /api/webauthn/register/options` (Bearer)
- `POST /api/webauthn/register/verify` (Bearer)
- `POST /api/webauthn/login/options` `{ cnpj }`
- `POST /api/webauthn/login/verify`
- `GET /api/webauthn/credentials` (Bearer)
- `DELETE /api/webauthn/credentials/:id` (Bearer)
