/**
 * Texto legível de um erro para log.
 *
 * Alguns erros chegam com `message` vazia: ao recusar a conexão, o driver `pg`
 * lança um AggregateError sem mensagem, só com `code` (ex: ECONNREFUSED).
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.message) return err.message;
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    return err.name;
  }
  return String(err);
}
