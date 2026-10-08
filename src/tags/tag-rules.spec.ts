import { checkTagLimits } from './tag-rules';

describe('checkTagLimits', () => {
  it('aceita limites completos e em ordem', () => {
    expect(
      checkTagLimits({
        engMin: 0,
        engMax: 100,
        alarmLL: 10,
        alarmL: 20,
        alarmH: 80,
        alarmHH: 90,
      }),
    ).toEqual([]);
  });

  it('aceita limites ausentes ou nulos', () => {
    expect(checkTagLimits({})).toEqual([]);
    expect(checkTagLimits({ alarmL: null, alarmH: 5 })).toEqual([]);
  });

  it('aceita LL = L e H = HH, mas não L = H', () => {
    expect(checkTagLimits({ alarmLL: 10, alarmL: 10, alarmH: 90, alarmHH: 90 })).toEqual([]);
    expect(checkTagLimits({ alarmL: 50, alarmH: 50 })).toEqual([
      'alarmL deve ser menor que alarmH',
    ]);
  });

  it('recusa faixa invertida ou vazia', () => {
    expect(checkTagLimits({ engMin: 10, engMax: 10 })).toEqual([
      'engMin deve ser menor que engMax',
    ]);
  });

  it('compara limites não vizinhos (o CHECK do banco não pega este caso)', () => {
    expect(checkTagLimits({ alarmLL: 10, alarmH: 5 })).toEqual([
      'alarmLL deve ser menor que alarmH',
    ]);
  });

  it('lista todas as violações', () => {
    expect(checkTagLimits({ alarmLL: 30, alarmL: 20, alarmH: 90, alarmHH: 80 })).toEqual([
      'alarmLL deve ser menor ou igual a alarmL',
      'alarmH deve ser menor ou igual a alarmHH',
    ]);
  });
});
