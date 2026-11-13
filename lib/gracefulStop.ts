/**
 * Aguarda uma promise em voo com prazo máximo, sem manter o processo vivo.
 * Devolve `true` quando o prazo estourou (a operação continua, mas o shutdown
 * não espera mais) e `false` quando a promise assentou.
 */
export function raceWithTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(timedOut);
    };
    const timer = setTimeout(() => finish(true), Math.max(0, Math.floor(Number(timeoutMs) || 0)));
    if (typeof (timer as any).unref === 'function') (timer as any).unref();
    promise.then(
      () => finish(false),
      () => finish(false),
    );
  });
}
