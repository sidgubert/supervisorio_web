import { DEFAULT_SIGNALS, generateSample, sampleSignal, SignalSpec } from './signal';

const spec: SignalSpec = { tag: 'T', mean: 10, amplitude: 2, periodSec: 4, noise: 0 };

describe('sampleSignal', () => {
  it('sem ruído, segue mean + amplitude * sin(2πt/T)', () => {
    expect(sampleSignal(spec, 0)).toBeCloseTo(10); // sin(0) = 0
    expect(sampleSignal(spec, 1000)).toBeCloseTo(12); // 1/4 do período: pico
    expect(sampleSignal(spec, 3000)).toBeCloseTo(8); // 3/4 do período: vale
  });

  it('é periódico', () => {
    expect(sampleSignal(spec, 1000)).toBeCloseTo(sampleSignal(spec, 5000));
  });

  it('com ruído, fica dentro de mean ± (amplitude + noise)', () => {
    const noisy = { ...spec, noise: 0.5 };
    for (let t = 0; t < 10_000; t += 37) {
      const v = sampleSignal(noisy, t);
      expect(v).toBeGreaterThanOrEqual(10 - 2 - 0.5);
      expect(v).toBeLessThanOrEqual(10 + 2 + 0.5);
    }
  });

  it('arredonda para 3 casas decimais', () => {
    const v = sampleSignal({ ...spec, noise: 0.123456 }, 123);
    expect(v).toBe(Number(v.toFixed(3)));
  });
});

describe('generateSample', () => {
  it('monta a amostra da tag no instante informado', () => {
    const at = new Date(1000);
    expect(generateSample(spec, at)).toEqual({ time: at, tag: 'T', value: 12 });
  });
});

describe('DEFAULT_SIGNALS', () => {
  it('tem tags únicas e períodos positivos', () => {
    const tags = DEFAULT_SIGNALS.map((s) => s.tag);
    expect(new Set(tags).size).toBe(tags.length);
    for (const s of DEFAULT_SIGNALS) expect(s.periodSec).toBeGreaterThan(0);
  });
});
