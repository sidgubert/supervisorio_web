/**
 * Validação e resolução dos parâmetros de GET /measurements/:tag/history.
 * Função pura (recebe `now`), para ser testada sem banco nem relógio.
 */

export type Bucket = 'raw' | '1m' | '1h';
export const BUCKETS: readonly Bucket[] = ['raw', '1m', '1h'];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Período padrão quando `from` é omitido. */
const DEFAULT_RANGE_MS = HOUR;

/**
 * Maior período aceito por resolução, para limitar o tamanho da resposta
 * (com o simulador a 1 Hz: 6 h bruto = ~21 mil pontos; 7 d em 1m = ~10 mil).
 */
export const MAX_RANGE_MS: Record<Bucket, number> = {
  raw: 6 * HOUR,
  '1m': 7 * DAY,
  '1h': 400 * DAY,
};

/** `bucket=auto`: a menor resolução que mantém o gráfico com ~2 mil pontos. */
function autoBucket(rangeMs: number): Bucket {
  if (rangeMs <= 30 * MINUTE) return 'raw';
  if (rangeMs <= 36 * HOUR) return '1m';
  return '1h';
}

export interface HistoryQuery {
  from: Date;
  to: Date;
  bucket: Bucket;
}

export class HistoryQueryError extends Error {}

/**
 * `minutes` é um atalho para "os últimos N minutos até `to`" (o dashboard usa
 * minutes=15); não pode ser combinado com `from`.
 */
export function parseHistoryQuery(
  raw: { from?: string; to?: string; bucket?: string; minutes?: string },
  now: Date,
): HistoryQuery {
  const to = raw.to ? parseDate('to', raw.to) : now;
  let from: Date;
  if (raw.minutes !== undefined) {
    if (raw.from) throw new HistoryQueryError('use minutes ou from, não os dois');
    const m = Number(raw.minutes);
    if (!Number.isInteger(m) || m < 1) {
      throw new HistoryQueryError('minutes deve ser um inteiro positivo');
    }
    from = new Date(to.getTime() - m * MINUTE);
  } else {
    from = raw.from ? parseDate('from', raw.from) : new Date(to.getTime() - DEFAULT_RANGE_MS);
  }
  const range = to.getTime() - from.getTime();
  if (range <= 0) throw new HistoryQueryError('from deve ser anterior a to');

  const requested = raw.bucket ?? 'auto';
  let bucket: Bucket;
  if (requested === 'auto') {
    bucket = autoBucket(range);
  } else if ((BUCKETS as readonly string[]).includes(requested)) {
    bucket = requested as Bucket;
  } else {
    throw new HistoryQueryError(`bucket deve ser auto, ${BUCKETS.join(', ')}`);
  }

  if (range > MAX_RANGE_MS[bucket]) {
    throw new HistoryQueryError(
      `período longo demais para bucket=${bucket} (máx ${formatRange(MAX_RANGE_MS[bucket])})`,
    );
  }
  return { from, to, bucket };
}

function parseDate(name: string, value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new HistoryQueryError(`${name} deve ser uma data ISO 8601 (ex: 2026-10-07T12:00:00Z)`);
  }
  return d;
}

function formatRange(ms: number): string {
  return ms >= DAY ? `${ms / DAY} dias` : `${ms / HOUR} horas`;
}
