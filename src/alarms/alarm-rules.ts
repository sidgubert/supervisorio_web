/**
 * Regras de alarme em funções puras: dado o estado atual de uma tag e um novo
 * valor, quais alarmes ativam e quais normalizam.
 */

export type AlarmLevel = 'LL' | 'L' | 'H' | 'HH';
export const ALARM_LEVELS: readonly AlarmLevel[] = ['HH', 'H', 'L', 'LL'];

/** Prioridade para ordenar a lista de alarmes (maior = mais grave). */
export const LEVEL_PRIORITY: Record<AlarmLevel, number> = { HH: 2, LL: 2, H: 1, L: 1 };

/** Limites de uma tag, como estão no cadastro. */
export interface AlarmLimits {
  alarmLL?: number | null;
  alarmL?: number | null;
  alarmH?: number | null;
  alarmHH?: number | null;
  alarmDeadband?: number | null;
}

const FIELD: Record<AlarmLevel, keyof AlarmLimits> = {
  LL: 'alarmLL',
  L: 'alarmL',
  H: 'alarmH',
  HH: 'alarmHH',
};

const isHigh = (level: AlarmLevel) => level === 'H' || level === 'HH';

/** Níveis configurados (com limite) e o valor de cada um. */
export function configuredLevels(limits: AlarmLimits): Map<AlarmLevel, number> {
  const out = new Map<AlarmLevel, number>();
  for (const level of ALARM_LEVELS) {
    const v = limits[FIELD[level]];
    if (typeof v === 'number' && Number.isFinite(v)) out.set(level, v);
  }
  return out;
}

export interface AlarmTransitions {
  raise: { level: AlarmLevel; limit: number }[];
  clear: AlarmLevel[];
}

/**
 * Compara o valor com cada limite, considerando quais níveis já estão ativos.
 *
 * - Alto (H/HH) ativa com valor >= limite e normaliza com valor < limite - banda.
 * - Baixo (L/LL) ativa com valor <= limite e normaliza com valor > limite + banda.
 * - Cada nível é independente: acima de HH, H e HH ficam ativos juntos.
 * - Um nível ativo cujo limite saiu do cadastro normaliza.
 */
export function evaluate(
  limits: AlarmLimits,
  active: ReadonlySet<AlarmLevel>,
  value: number,
): AlarmTransitions {
  const deadband = Math.max(0, limits.alarmDeadband ?? 0);
  const levels = configuredLevels(limits);
  const raise: AlarmTransitions['raise'] = [];
  const clear: AlarmLevel[] = [];

  for (const [level, limit] of levels) {
    const violated = isHigh(level) ? value >= limit : value <= limit;
    const normal = isHigh(level) ? value < limit - deadband : value > limit + deadband;
    if (!active.has(level) && violated) raise.push({ level, limit });
    else if (active.has(level) && normal) clear.push(level);
  }
  for (const level of active) if (!levels.has(level)) clear.push(level);
  return { raise, clear };
}
