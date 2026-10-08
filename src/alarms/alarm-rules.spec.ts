import { AlarmLevel, configuredLevels, evaluate } from './alarm-rules';

const none = new Set<AlarmLevel>();
const act = (...levels: AlarmLevel[]) => new Set<AlarmLevel>(levels);

describe('configuredLevels', () => {
  it('lista só os níveis com limite numérico', () => {
    expect([...configuredLevels({ alarmH: 90, alarmL: null, alarmLL: 10 })]).toEqual([
      ['H', 90],
      ['LL', 10],
    ]);
  });
});

describe('evaluate', () => {
  const limits = { alarmLL: 10, alarmL: 20, alarmH: 80, alarmHH: 90 };

  it('valor normal não gera nada', () => {
    expect(evaluate(limits, none, 50)).toEqual({ raise: [], clear: [] });
  });

  it('ativa H no limite (>=) e L no limite (<=)', () => {
    expect(evaluate(limits, none, 80).raise).toEqual([{ level: 'H', limit: 80 }]);
    expect(evaluate(limits, none, 20).raise).toEqual([{ level: 'L', limit: 20 }]);
  });

  it('acima de HH, ativa H e HH juntos', () => {
    expect(
      evaluate(limits, none, 95)
        .raise.map((r) => r.level)
        .sort(),
    ).toEqual(['H', 'HH']);
  });

  it('não repete um nível que já está ativo', () => {
    expect(evaluate(limits, act('H'), 85)).toEqual({ raise: [], clear: [] });
  });

  it('normaliza ao voltar para a faixa normal', () => {
    expect(evaluate(limits, act('H', 'HH'), 85)).toEqual({ raise: [], clear: ['HH'] });
    expect(evaluate(limits, act('H'), 79)).toEqual({ raise: [], clear: ['H'] });
    expect(evaluate(limits, act('L'), 21)).toEqual({ raise: [], clear: ['L'] });
  });

  it('banda morta: só normaliza depois de passar do limite ± banda', () => {
    const withBand = { ...limits, alarmDeadband: 2 };
    expect(evaluate(withBand, act('H'), 79)).toEqual({ raise: [], clear: [] }); // 79 >= 78
    expect(evaluate(withBand, act('H'), 77.9)).toEqual({ raise: [], clear: ['H'] });
    expect(evaluate(withBand, act('L'), 21.5)).toEqual({ raise: [], clear: [] }); // 21.5 <= 22
    expect(evaluate(withBand, act('L'), 22.1)).toEqual({ raise: [], clear: ['L'] });
    // A banda não muda o ponto de ativação.
    expect(evaluate(withBand, none, 80).raise).toEqual([{ level: 'H', limit: 80 }]);
  });

  it('banda negativa é tratada como zero', () => {
    expect(evaluate({ alarmH: 80, alarmDeadband: -5 }, act('H'), 79).clear).toEqual(['H']);
  });

  it('nível ativo cujo limite saiu do cadastro normaliza', () => {
    expect(evaluate({ alarmH: 80 }, act('H', 'HH'), 95)).toEqual({ raise: [], clear: ['HH'] });
    expect(evaluate({}, act('L'), 5)).toEqual({ raise: [], clear: ['L'] });
  });
});
