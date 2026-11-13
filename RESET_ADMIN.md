# Acesso administrativo

## Identidade administrativa

O painel administrativo usa `POST /api/admin/login`, implementado em
`adminLoginRoute.ts`. A rota consulta o usuário na tabela `usuarios`, valida
a senha armazenada com bcrypt e aceita somente:

- usuário cujo `empresa_id` seja `admin`; ou
- usuário cujo e-mail corresponda a `ADMIN_EMAIL` (padrão:
  `admin@seusaas.com`, se a variável não estiver configurada).

Se MFA estiver habilitado, o acesso só é concluído após a validação do desafio
e do código MFA.

## Sessão e autorização

Após autenticação administrativa bem-sucedida, o backend emite um JWT assinado
com o claim `platform_admin: true`. Esse claim é a prova explícita de privilégio
administrativo para contas cujo `empresa_id` é um tenant comum.

**Não** crie tokens administrativos manualmente e não use `role: 'admin'`
como prova de privilégio. O campo `role` legado não concede acesso de
plataforma. Tokens administrativos antigos devem ser renovados pelo fluxo
`/api/admin/login` (e MFA, quando habilitado).

O login de empresa permanece separado em `/api/auth/login` (ou na rota de
login de empresa configurada pelo frontend); ele não concede privilégios
administrativos.

## Recuperação de acesso

Não existe senha padrão segura para documentar. Não use credenciais copiadas
de documentação, scripts ou histórico de terminal. A redefinição deve ser
realizada por um operador autorizado, usando o procedimento de gestão de
credenciais do ambiente e armazenando somente o hash bcrypt no banco.

Após a redefinição, entre pelo painel administrativo e conclua o MFA, se
habilitado. Se o login falhar, verifique o e-mail administrativo configurado,
a existência do usuário, o hash bcrypt e os logs do backend sem registrar
senhas, tokens ou códigos MFA.

## Verificações

- `POST /api/admin/login`: autentica a conta administrativa.
- `GET /api/admin/me`: valida a sessão administrativa atual.
- `POST /api/admin/logout`: encerra a sessão no navegador.

Nunca compartilhe o JWT, cookies de sessão, senha ou códigos de recuperação.
