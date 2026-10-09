import {
  DEFAULT_SIGNALS,
  findSignal,
  generateSample,
  generatedSignal,
  noiseAt,
  sampleSignal,
  SignalSpec,
  simulatorSignals,
} from './signal';

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

  it('é determinístico: mesma tag e instante, mesmo valor (inclusive o ruído)', () => {
    const noisy = { ...spec, noise: 0.5 };
    const t = Date.parse('2026-10-08T12:00:00.123Z');
    expect(sampleSignal(noisy, t)).toBe(sampleSignal({ ...noisy }, t));
    expect(sampleSignal(noisy, t)).not.toBe(sampleSignal(noisy, t + 1));
    expect(sampleSignal(noisy, t)).not.toBe(sampleSignal({ ...noisy, tag: 'U' }, t));
  });

  it('arredonda para 3 casas decimais', () => {
    const v = sampleSignal({ ...spec, noise: 0.123456 }, 123);
    expect(v).toBe(Number(v.toFixed(3)));
  });
});

describe('noiseAt', () => {
  it('fica em [-1, 1) e se distribui de forma praticamente uniforme', () => {
    const t0 = Date.parse('2026-10-08T00:00:00Z');
    const bins = new Array<number>(10).fill(0);
    let sum = 0;
    const n = 100_000;
    for (let i = 0; i < n; i++) {
      const x = noiseAt('TIC-101.PV', t0 + i); // instantes vizinhos, 1 ms
      expect(x).toBeGreaterThanOrEqual(-1);
      expect(x).toBeLessThan(1);
      sum += x;
      bins[Math.floor((x + 1) * 5)]++;
    }
    expect(Math.abs(sum / n)).toBeLessThan(0.01); // média ~0
    for (const b of bins) expect(b / n).toBeGreaterThan(0.09); // cada décimo ~10%
    for (const b of bins) expect(b / n).toBeLessThan(0.11);
  });

  it('usa todo o instante, inclusive acima de 32 bits', () => {
    expect(noiseAt('T', 2 ** 32 + 5)).not.toBe(noiseAt('T', 5));
  });
});

describe('simulatorSignals e findSignal', () => {
  it('até 4 tags, as de exemplo; acima disso, tags geradas', () => {
    expect(simulatorSignals(2).map((s) => s.tag)).toEqual(['TIC-101.PV', 'PIC-201.PV']);
    const many = simulatorSignals(1000);
    expect(many).toHaveLength(1000);
    expect(many[4].tag).toBe('SIM-0005.PV');
    expect(many[999].tag).toBe('SIM-1000.PV');
    expect(new Set(many.map((s) => s.tag)).size).toBe(1000);
    for (const s of many) expect(s.periodSec).toBeGreaterThan(0);
  });

  it('acha o sinal de qualquer tag do simulador pelo nome', () => {
    expect(findSignal('FIC-301.PV')).toBe(DEFAULT_SIGNALS[2]);
    expect(findSignal('SIM-0042.PV')).toEqual(generatedSignal(42));
    expect(findSignal('SIM-10000.PV')).toEqual(generatedSignal(10_000));
    expect(findSignal('SIM-0003.PV')).toBeUndefined(); // 1 a 4 são as de exemplo
    expect(findSignal('SIM-042.PV')).toBeUndefined();
    expect(findSignal('SIM-00042.PV')).toBeUndefined();
    expect(findSignal('TT-900.PV')).toBeUndefined();
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
