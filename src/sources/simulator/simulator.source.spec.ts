import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.validation';
import { SampleInput } from '../../ingestion/sample';
import { IngestionService } from '../../ingestion/ingestion.service';
import { DEFAULT_SIGNALS } from './signal';
import { SimulatorSource } from './simulator.source';

function makeSource(env: Partial<Pick<Env, 'SIM_ENABLED' | 'SIM_INTERVAL_MS' | 'SIM_TAGS'>> = {}) {
  const values = { SIM_ENABLED: true, SIM_INTERVAL_MS: 1000, SIM_TAGS: 4, ...env };
  const config = {
    get: (k: keyof typeof values) => values[k],
  } as unknown as ConfigService<Env, true>;
  const ingestion = { register: jest.fn() };
  const source = new SimulatorSource(config, ingestion as unknown as IngestionService);
  return { source, ingestion };
}

beforeAll(() => Logger.overrideLogger(false));

describe('SimulatorSource', () => {
  afterEach(() => jest.useRealTimers());

  it('se registra na ingestão quando habilitado', () => {
    const { source, ingestion } = makeSource();
    source.onModuleInit();
    expect(ingestion.register).toHaveBeenCalledWith(source);
  });

  it('não se registra com SIM_ENABLED=false', () => {
    const { source, ingestion } = makeSource({ SIM_ENABLED: false });
    source.onModuleInit();
    expect(ingestion.register).not.toHaveBeenCalled();
  });

  it('emite uma amostra por tag a cada intervalo, todas com o mesmo instante', () => {
    jest.useFakeTimers();
    const { source } = makeSource({ SIM_INTERVAL_MS: 100 });
    const batches: SampleInput[][] = [];
    source.start((s) => batches.push(s));
    jest.advanceTimersByTime(300);
    expect(batches).toHaveLength(3);
    for (const batch of batches) {
      expect(batch.map((s) => s.tag)).toEqual(DEFAULT_SIGNALS.map((s) => s.tag));
      expect(new Set(batch.map((s) => s.time?.getTime())).size).toBe(1);
    }
  });

  it('SIM_TAGS: gera a quantidade pedida de tags (teste de carga)', () => {
    jest.useFakeTimers();
    const { source } = makeSource({ SIM_INTERVAL_MS: 100, SIM_TAGS: 250 });
    const batches: SampleInput[][] = [];
    source.start((s) => batches.push(s));
    jest.advanceTimersByTime(100);
    expect(batches[0]).toHaveLength(250);
    expect(batches[0].at(-1)?.tag).toBe('SIM-0250.PV');
    expect(source.status().tags).toBe(250);
    source.stop();
  });

  it('para de emitir após stop', () => {
    jest.useFakeTimers();
    const { source } = makeSource({ SIM_INTERVAL_MS: 100 });
    const emit = jest.fn();
    source.start(emit);
    jest.advanceTimersByTime(100);
    source.stop();
    jest.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
