import { Logger } from '@nestjs/common';

/**
 * Log com limite de frequência por chave: a primeira ocorrência sai na hora e
 * as seguintes no máximo uma vez por intervalo, com a contagem do que foi
 * suprimido. Evita que um problema repetitivo (um broker fora do ar tentando
 * reconectar a cada 2 s, um dispositivo mandando payload inválido 10 vezes
 * por segundo) inunde o log.
 */
export class RateLimitedLogger {
  private readonly state = new Map<string, { last: number; suppressed: number }>();

  constructor(
    private readonly logger: Logger,
    private readonly intervalMs = 60_000,
  ) {}

  warn(key: string, message: string) {
    this.log('warn', key, message);
  }

  error(key: string, message: string) {
    this.log('error', key, message);
  }

  /** Esquece a chave (ex: conexão restabelecida): o próximo problema sai na hora. */
  reset(key: string) {
    this.state.delete(key);
  }

  private log(level: 'warn' | 'error', key: string, message: string) {
    const now = Date.now();
    const st = this.state.get(key);
    if (st && now - st.last < this.intervalMs) {
      st.suppressed++;
      return;
    }
    const suffix =
      st && st.suppressed > 0 ? ` (+${st.suppressed} ocorrência(s) desde o último aviso)` : '';
    this.logger[level](message + suffix);
    this.state.set(key, { last: now, suppressed: 0 });
  }
}
