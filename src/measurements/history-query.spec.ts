import { HistoryQueryError, parseHistoryQuery } from './history-query';

const now = new Date('2026-10-07T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('parseHistoryQuery', () => {
  it('sem parâmetros: última hora, resolução automática (1m)', () => {
    expect(parseHistoryQuery({}, now)).toEqual({
      from: new Date(now.getTime() - HOUR),
      to: now,
      bucket: '1m',
    });
  });

  it.each([
    [10 * MIN, 'raw'],
    [30 * MIN, 'raw'],
    [2 * HOUR, '1m'],
    [36 * HOUR, '1m'],
    [3 * DAY, '1h'],
    [300 * DAY, '1h'],
  ])('auto: período de %i ms usa bucket %s', (range, bucket) => {
    expect(parseHistoryQuery({ from: ago(range) }, now).bucket).toBe(bucket);
  });

  it('respeita o bucket pedido', () => {
    expect(parseHistoryQuery({ from: ago(2 * HOUR), bucket: 'raw' }, now).bucket).toBe('raw');
  });

  it.each([
    [{ from: 'ontem' }, /from deve ser uma data/],
    [{ to: '2026-13-45' }, /to deve ser uma data/],
    [{ from: ago(0), to: ago(HOUR) }, /anterior a to/],
    [{ bucket: '5m' }, /bucket deve ser/],
    [{ from: ago(7 * HOUR), bucket: 'raw' }, /longo demais para bucket=raw \(máx 6 horas\)/],
    [{ from: ago(8 * DAY), bucket: '1m' }, /máx 7 dias/],
    [{ from: ago(401 * DAY) }, /longo demais para bucket=1h/],
  ])('rejeita %j', (q, msg) => {
    expect(() => parseHistoryQuery(q, now)).toThrow(HistoryQueryError);
    expect(() => parseHistoryQuery(q, now)).toThrow(msg);
  });
});
