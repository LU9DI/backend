/**
 * Contrato explícito de ator do Filtra Dot.
 *
 * O ator NUNCA é inferido pela ausência de um campo. Quem chama precisa dizer
 * quem é o ator, em uma das duas formas válidas:
 *
 *  - `user`: usuário autenticado, com `userId` obrigatório (vem exclusivamente
 *    do token validado nas rotas HTTP);
 *  - `dot`: ator interno autorizado (monitor, scheduler, sistema), sem ID
 *    humano; a origem precisa ser declarada.
 *
 * Qualquer outra coisa (`undefined`, `null`, string solta, ID em branco, tipo
 * desconhecido) é rejeitada com `DotActorIdentityError` — nunca convertida em
 * ator `dot` por omissão.
 */

/** Origens internas autorizadas a agir sem usuário humano. */
export const DOT_INTERNAL_ACTOR_SOURCES = ['monitor', 'scheduler', 'system'] as const;

export type DotInternalActorSource = (typeof DOT_INTERNAL_ACTOR_SOURCES)[number];

export type DotUserActor = {
  readonly type: 'user';
  readonly userId: string;
};

export type DotInternalActor = {
  readonly type: 'dot';
  readonly source: DotInternalActorSource;
};

export type DotActor = DotUserActor | DotInternalActor;

/**
 * Identidade ausente, inválida ou não autorizada. Fail-closed: a operação do
 * Dot não prossegue e nenhuma escrita/auditoria de sucesso é feita.
 */
export class DotActorIdentityError extends Error {
  readonly code = 'DOT_ACTOR_IDENTITY_REQUIRED';
  readonly status = 403;

  constructor(message = 'Ator do Dot ausente ou inválido: é obrigatório identificar o usuário autenticado ou declarar o ator interno autorizado.') {
    super(message);
    this.name = 'DotActorIdentityError';
  }
}

function normalizeUserId(userId: unknown): string | null {
  if (typeof userId !== 'string') return null;
  const trimmed = userId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeInternalSource(source: unknown): DotInternalActorSource | null {
  if (typeof source !== 'string') return null;
  const normalized = source.trim().toLowerCase();
  return (DOT_INTERNAL_ACTOR_SOURCES as readonly string[]).includes(normalized)
    ? (normalized as DotInternalActorSource)
    : null;
}

/** Constrói um ator de usuário autenticado; rejeita ID ausente/em branco. */
export function dotUserActor(userId: string | null | undefined): DotUserActor {
  const normalized = normalizeUserId(userId);
  if (!normalized) {
    throw new DotActorIdentityError('Usuário autenticado sem identificador válido não pode agir no Dot.');
  }
  return { type: 'user', userId: normalized };
}

/** Constrói um ator interno autorizado; rejeita origem não declarada/desconhecida. */
export function dotInternalActor(source: DotInternalActorSource): DotInternalActor {
  const normalized = normalizeInternalSource(source);
  if (!normalized) {
    throw new DotActorIdentityError('Ator interno do Dot exige uma origem autorizada (monitor, scheduler ou system).');
  }
  return { type: 'dot', source: normalized };
}

/**
 * Valida e normaliza o contrato de ator. Toda entrada que não seja um ator
 * `user` com ID válido ou um ator `dot` com origem autorizada é rejeitada.
 */
export function resolveDotActor(actor: DotActor | null | undefined): DotActor {
  if (!actor || typeof actor !== 'object') {
    throw new DotActorIdentityError();
  }
  const candidate = actor as { type?: unknown; userId?: unknown; source?: unknown };
  if (candidate.type === 'user') {
    return dotUserActor(typeof candidate.userId === 'string' ? candidate.userId : null);
  }
  if (candidate.type === 'dot') {
    return dotInternalActor(
      (typeof candidate.source === 'string' ? candidate.source : '') as DotInternalActorSource,
    );
  }
  throw new DotActorIdentityError();
}

/** Colunas de auditoria correspondentes ao ator efetivo (nunca usuário anônimo). */
export function dotActorAuditColumns(actor: DotActor): { actorType: 'user' | 'dot'; actorId: string | null } {
  return actor.type === 'user'
    ? { actorType: 'user', actorId: actor.userId }
    : { actorType: 'dot', actorId: null };
}

/** Metadados de auditoria que identificam a origem do ator interno. */
export function dotActorAuditMetadata(actor: DotActor): Record<string, unknown> {
  return actor.type === 'user'
    ? { actor_source: null }
    : { actor_source: actor.source };
}
