/**
 * Texto legível de um erro para log.
 *
 * Bibliotecas nem sempre lançam `Error` com mensagem:
 * - o driver `pg`, ao recusar a conexão, lança um AggregateError com
 *   `message` vazia e o motivo só em `code` (ECONNREFUSED);
 * - o `modbus-serial` rejeita com objetos comuns `{ name, message, errno }`.
 *
 * Usa a mensagem quando houver e acrescenta o código (code/errno) se ele
 * ainda não estiver nela: "Port Not Open (ECONNREFUSED)".
 */
export function errorMessage(err: unknown): string {
  if (typeof err !== 'object' || err === null) return String(err);

  const { message, code, errno, name } = err as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  const reason = text(code) ?? text(errno);
  const base = text(message) ?? reason ?? text(name);
  if (!base) {
    try {
      return JSON.stringify(err);
    } catch {
      return 'erro sem descrição'; // objeto circular
    }
  }
  return reason && !base.includes(reason) ? `${base} (${reason})` : base;
}
