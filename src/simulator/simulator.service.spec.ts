import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env.validation';
import { MeasurementsService } from '../measurements/measurements.service';
import { DEFAULT_SIGNALS, Sample } from './signal';
import { SimulatorService } from './simulator.service';

const TAGS = DEFAULT_SIGNALS.length;

/** Banco falso: pode ser "derrubado" e guarda o que foi gravado. */
function fakeDb() {
  const db = {
    down: false,
    saved: [] as Sample[],
    calls: 0,
    insertBatch: jest.fn(async (rows: Sample[]) => {
      db.calls++;
      await Promise.resolve();
      if (db.down) throw new Error('db down');
      db.saved.push(...rows);
      return rows.length;
    }),
  };
  return db;
}

function makeSim(env: Partial<Env> = {}) {
  const values: Env = {
    DB_HOST: 'x',
    DB_PORT: 1,
    DB_USER: 'x',
    DB_PASSWORD: 'x',
    DB_NAME: 'x',
    PORT: 1,
    SIM_ENABLED: true,
    SIM_INTERVAL_MS: 1000,
    SIM_BATCH_FLUSH_MS: 2000,
    SIM_BUFFER_MAX: 100,
    ...env,
  };
  const config = { get: (k: keyof Env) => values[k] } as unknown as ConfigService<Env, true>;
  const db = fakeDb();
  const sim = new SimulatorService(config, db as unknown as MeasurementsService) as any;
  sim.maxBuffer = values.SIM_BUFFER_MAX;
  return { sim, db };
}

beforeAll(() => Logger.overrideLogger(false));

describe('SimulatorService', () => {
  afterEach(() => jest.useRealTimers());

  it('gera uma amostra por tag a cada ciclo', () => {
    const { sim } = makeSim();
    sim.generate();
    expect(sim.buffer).toHaveLength(TAGS);
  });

  it('grava o buffer e o esvazia', async () => {
    const { sim, db } = makeSim();
    sim.generate();
    await sim.flush();
    expect(db.saved).toHaveLength(TAGS);
    expect(sim.buffer).toHaveLength(0);
  });

  it('com o banco fora, respeita o teto descartando as amostras mais antigas', async () => {
    const { sim, db } = makeSim({ SIM_BUFFER_MAX: 10 });
    db.down = true;
    sim.generate();
    const oldest: Sample = sim.buffer[0];
    for (let i = 0; i < 4; i++) {
      await sim.flush();
      sim.generate();
    }
    expect(sim.buffer).toHaveLength(10);
    expect(sim.buffer).not.toContain(oldest);
  });

  it('quando o banco volta, grava tudo em ordem cronológica', async () => {
    jest.useFakeTimers({ now: 0 });
    const { sim, db } = makeSim();
    db.down = true;
    for (let i = 0; i < 3; i++) {
      jest.setSystemTime(i * 1000);
      sim.generate();
      await sim.flush();
    }
    db.down = false;
    await sim.flush();
    const times = db.saved.map((s) => s.time.getTime());
    expect(db.saved).toHaveLength(3 * TAGS);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('não dispara dois flush simultâneos', async () => {
    const { sim, db } = makeSim();
    sim.generate();
    const p1 = sim.flush();
    const p2 = sim.flush();
    expect(p2).toBe(p1);
    await p1;
    expect(db.calls).toBe(1);
  });

  it('grava no máximo maxPerFlush amostras por ciclo', async () => {
    const { sim, db } = makeSim({ SIM_BUFFER_MAX: 1000 });
    sim.maxPerFlush = 5;
    sim.generate();
    sim.generate();
    await sim.flush();
    expect(db.saved).toHaveLength(5);
    expect(sim.buffer).toHaveLength(2 * TAGS - 5);
  });

  it('onModuleDestroy grava o buffer restante', async () => {
    const { sim, db } = makeSim({ SIM_BUFFER_MAX: 1000 });
    sim.maxPerFlush = 3;
    sim.generate();
    sim.generate();
    await sim.onModuleDestroy();
    expect(sim.buffer).toHaveLength(0);
    expect(db.saved).toHaveLength(2 * TAGS);
  });

  it('onModuleDestroy não entra em loop se o banco estiver fora', async () => {
    const { sim, db } = makeSim();
    db.down = true;
    sim.generate();
    await sim.onModuleDestroy();
    expect(sim.buffer).toHaveLength(TAGS);
    expect(db.calls).toBe(1);
  });

  it('onModuleInit com SIM_ENABLED=false não agenda timers', () => {
    const { sim } = makeSim({ SIM_ENABLED: false });
    sim.onModuleInit();
    expect(sim.genTimer).toBeUndefined();
    expect(sim.flushTimer).toBeUndefined();
  });

  it('onModuleInit gera e grava nos intervalos configurados', async () => {
    jest.useFakeTimers();
    const { sim, db } = makeSim({ SIM_INTERVAL_MS: 100, SIM_BATCH_FLUSH_MS: 300 });
    sim.onModuleInit();
    await jest.advanceTimersByTimeAsync(300);
    expect(db.saved).toHaveLength(3 * TAGS);
    await sim.onModuleDestroy();
  });
});
