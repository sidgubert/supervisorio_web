import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env.validation';
import { MeasurementsService } from '../measurements/measurements.service';
import { IngestionBuffer } from './ingestion-buffer';
import { Sample } from './sample';

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

function makeBuffer(env: Partial<Env> = {}) {
  const values = { INGEST_FLUSH_MS: 2000, INGEST_BUFFER_MAX: 100, ...env };
  const config = {
    get: (k: keyof typeof values) => values[k],
  } as unknown as ConfigService<Env, true>;
  const db = fakeDb();
  const buffer = new IngestionBuffer(config, db as unknown as MeasurementsService) as any;
  return { buffer, db };
}

/** n amostras com time = início, início+1, ... (ms). */
function samples(n: number, start = 0): Sample[] {
  return Array.from({ length: n }, (_, i) => ({
    time: new Date(start + i),
    tag: 'T',
    value: i,
    quality: 192,
    source: 'test',
  }));
}

beforeAll(() => Logger.overrideLogger(false));

describe('IngestionBuffer', () => {
  afterEach(() => jest.useRealTimers());

  it('grava o buffer e o esvazia', async () => {
    const { buffer, db } = makeBuffer();
    buffer.push(samples(4));
    await buffer.flush();
    expect(db.saved).toHaveLength(4);
    expect(buffer.pending).toBe(0);
  });

  it('respeita o teto descartando as amostras mais antigas', () => {
    const { buffer } = makeBuffer({ INGEST_BUFFER_MAX: 10 });
    const all = samples(15);
    buffer.push(all);
    expect(buffer.pending).toBe(10);
    expect(buffer.buffer[0]).toBe(all[5]);
  });

  it('com o banco fora, mantém as amostras até o teto', async () => {
    const { buffer, db } = makeBuffer({ INGEST_BUFFER_MAX: 10 });
    db.down = true;
    for (let i = 0; i < 5; i++) {
      buffer.push(samples(4, i * 4));
      await buffer.flush();
    }
    expect(buffer.pending).toBe(10);
    expect(buffer.buffer[0].time.getTime()).toBe(10); // as 10 mais recentes
  });

  it('quando o banco volta, grava tudo em ordem cronológica', async () => {
    const { buffer, db } = makeBuffer();
    db.down = true;
    for (let i = 0; i < 3; i++) {
      buffer.push(samples(4, i * 4));
      await buffer.flush();
    }
    db.down = false;
    await buffer.flush();
    const times = db.saved.map((s) => s.time.getTime());
    expect(times).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });

  it('não dispara dois flush simultâneos', async () => {
    const { buffer, db } = makeBuffer();
    buffer.push(samples(4));
    const p1 = buffer.flush();
    const p2 = buffer.flush();
    expect(p2).toBe(p1);
    await p1;
    expect(db.calls).toBe(1);
  });

  it('grava no máximo maxPerFlush amostras por ciclo', async () => {
    const { buffer, db } = makeBuffer();
    buffer.maxPerFlush = 5;
    buffer.push(samples(8));
    await buffer.flush();
    expect(db.saved).toHaveLength(5);
    expect(buffer.pending).toBe(3);
  });

  it('aceita lotes grandes sem estourar a pilha', () => {
    const { buffer } = makeBuffer({ INGEST_BUFFER_MAX: 1_000_000 });
    expect(() => buffer.push(samples(500_000))).not.toThrow();
  });

  it('start grava periodicamente; stop grava o restante', async () => {
    jest.useFakeTimers();
    const { buffer, db } = makeBuffer({ INGEST_FLUSH_MS: 100 });
    buffer.start();
    buffer.push(samples(4));
    await jest.advanceTimersByTimeAsync(100);
    expect(db.saved).toHaveLength(4);
    buffer.push(samples(2, 4));
    await buffer.stop();
    expect(db.saved).toHaveLength(6);
  });

  it('stop esvazia o buffer em vários ciclos', async () => {
    const { buffer, db } = makeBuffer();
    buffer.maxPerFlush = 3;
    buffer.push(samples(8));
    await buffer.stop();
    expect(buffer.pending).toBe(0);
    expect(db.saved).toHaveLength(8);
  });

  it('stop não entra em loop se o banco estiver fora', async () => {
    const { buffer, db } = makeBuffer();
    db.down = true;
    buffer.push(samples(4));
    await buffer.stop();
    expect(buffer.pending).toBe(4);
    expect(db.calls).toBe(1);
  });
});
