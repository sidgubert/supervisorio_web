/**
 * Regras que envolvem mais de um campo do cadastro de tags, conferidas antes
 * de gravar para devolver uma mensagem clara.
 *
 * São mais completas que os CHECK da tabela (migration CreateTags), que só
 * comparam limites vizinhos: com `alarmL` vazio, o banco aceitaria
 * alarmLL = 10 e alarmH = 5.
 */

export interface TagLimits {
  engMin?: number | null;
  engMax?: number | null;
  alarmLL?: number | null;
  alarmL?: number | null;
  alarmH?: number | null;
  alarmHH?: number | null;
}

type Limit = 'alarmLL' | 'alarmL' | 'alarmH' | 'alarmHH';

const has = (v: number | null | undefined): v is number => v !== null && v !== undefined;

/** Lista de violações (vazia = ok). */
export function checkTagLimits(t: TagLimits): string[] {
  const errors: string[] = [];
  if (has(t.engMin) && has(t.engMax) && !(t.engMin < t.engMax)) {
    errors.push('engMin deve ser menor que engMax');
  }

  const le = (a: Limit, b: Limit, strict: boolean) => {
    const va = t[a];
    const vb = t[b];
    if (has(va) && has(vb) && !(strict ? va < vb : va <= vb)) {
      errors.push(`${a} deve ser ${strict ? 'menor que' : 'menor ou igual a'} ${b}`);
    }
  };
  le('alarmLL', 'alarmL', false);
  le('alarmH', 'alarmHH', false);
  // Todo limite baixo abaixo de todo limite alto.
  for (const low of ['alarmLL', 'alarmL'] as const) {
    for (const high of ['alarmH', 'alarmHH'] as const) le(low, high, true);
  }
  return errors;
}
