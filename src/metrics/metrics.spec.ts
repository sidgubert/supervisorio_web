import { BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { Subject } from 'rxjs';
import { DataSource } from 'typeorm';
import { Env } from '../config/env.validation';
import { InsertEvent } from '../ingestion/ingestion-buffer';
import { IngestionService } from '../ingestion/ingestion.service';
import { Sample } from '../ingestion/sample';
import { toCsv } from './csv';
import { MetricsCollectorService } from './metrics-collector.service';
import { MetricsController } from './metrics.controller';
import { RetentionService } from './retention.service';
import { StorageStatsService } from './storage-stats.service';

const s = (source: string): Sample => ({
  source,
  tag: 'T',
  value: 1,
  quality: 192,
  time: new Date(),
  receivedAt: new Date(),
});

function insert(sources: string[], ms: number): InsertEvent {
  return { samples: sources.map(s), inserted: sources.length, ms };
}

beforeAll(() => Logger.overrideLogger(false));

describe('MetricsCollectorService', () => {
  const T0 = Date.parse('2026-10-08T12:00:00Z');

  function collector() {
    jest.useFakeTimers({ now: T0 });
    const c = new MetricsCollectorService({
      inserts$: new Subject(),
    } as unknown as IngestionService);
    jest.useRealTimers();
    return c;
  }

  it('calcula amostras/s e lotes/s por fonte na janela de 60 s', () => {
    const c = collector();
    // 60 s de operação: 1 lote por segundo com 4 amostras do simulador.
    for (let sec = 0; sec < 60; sec++)
      c.recordInsert(insert(['sim', 'sim', 'sim', 'sim'], 10), T0 + sec * 1000);
    const snap = c.snapshot(T0 + 59_999);
    expect(snap.bySource.sim).toMatchObject({
      samplesPerSec: 4,
      batchesPerSec: 1,
      totalSamples: 240,
    });
    expect(snap.bySource.mqtt).toMatchObject({
      samplesPerSec: 0,
      totalSamples: 0,
      lastBatchAt: null,
    });
    expect(snap.totalSamples).toBe(240);
    expect(snap.totalBatches).toBe(60);
  });

  it('a janela desliza: amostras antigas saem da taxa, mas não do total', () => {
    const c = collector();
    c.recordInsert(insert(['mqtt', 'mqtt'], 5), T0);
    expect(c.snapshot(T0 + 120_000).bySource.mqtt).toMatchObject({
      samplesPerSec: 0,
      totalSamples: 2,
    });
  });

  it('logo após a subida, divide pelo tempo decorrido (e não por 60 s)', () => {
    const c = collector();
    c.recordInsert(insert(Array(10).fill('sim') as string[], 5), T0 + 1000);
    expect(c.snapshot(T0 + 2000).bySource.sim.samplesPerSec).toBe(5);
  });

  it('latência média por fonte e geral; lote com várias fontes conta para cada uma', () => {
    const c = collector();
    c.recordInsert(insert(['sim', 'modbus'], 10), T0);
    c.recordInsert(insert(['sim'], 30), T0);
    const snap = c.snapshot(T0 + 1000);
    expect(snap.bySource.sim.avgInsertMs).toBe(20);
    expect(snap.bySource.modbus.avgInsertMs).toBe(10);
    expect(snap.bySource.sim).toMatchObject({ p50InsertMs: 10, p95InsertMs: 30 });
    expect(snap.avgInsertMs).toBe(20);
  });

  it('conta clientes e eventos do tempo real, sem ficar negativo', () => {
    const c = collector();
    c.sseConnected();
    c.sseConnected();
    c.sseDisconnected();
    c.wsDisconnected();
    c.sseSent(5);
    c.wsSent(2);
    expect(c.snapshot()).toMatchObject({
      sseClients: 1,
      wsClients: 0,
      sseEventsSent: 5,
      wsEventsSent: 2,
    });
  });

  it('CPU: média desde a leitura mais antiga da janela; memória atual', () => {
    const inserts$ = new Subject<InsertEvent>();
    const c = new MetricsCollectorService({ inserts$ } as unknown as IngestionService);
    const usage = jest.spyOn(process, 'cpuUsage');
    usage.mockReturnValue({ user: 1_000_000, system: 0 }); // 1 s de CPU
    c.onModuleInit(); // primeira leitura, agora
    usage.mockReturnValue({ user: 1_500_000, system: 500_000 }); // +1 s de CPU
    const now = Date.now();
    const p = c.processMetrics(now + 4000); // em 4 s
    expect(p.cpuPct).toBeGreaterThan(24); // 1 s / ~4 s = 25%
    expect(p.cpuPct).toBeLessThanOrEqual(25.1);
    expect(p.rssMb).toBeGreaterThan(0);
    expect(p.heapUsedMb).toBeGreaterThan(0);
    c.onModuleDestroy();
    usage.mockRestore();
  });

  it('recebe as gravações da ingestão', () => {
    const inserts$ = new Subject<InsertEvent>();
    const c = new MetricsCollectorService({ inserts$ } as unknown as IngestionService);
    c.onModuleInit();
    inserts$.next(insert(['opcua'], 3));
    expect(c.snapshot().bySource.opcua.totalSamples).toBe(1);
    c.onModuleDestroy();
  });
});

describe('toCsv', () => {
  it('escapa vírgula, aspas e quebra de linha (RFC 4180)', () => {
    expect(toCsv([{ a: 'x,y', b: 'diz "oi"', c: 'linha1\nlinha2', d: 1.5 }])).toBe(
      'a,b,c,d\r\n"x,y","diz ""oi""","linha1\nlinha2",1.5\r\n',
    );
  });

  it('neutraliza injeção de fórmula, mas não números negativos', () => {
    expect(toCsv([{ t: '=HYPERLINK("x")', u: '+1', v: '@SUM(A1)', n: -5 }])).toBe(
      't,u,v,n\r\n"\'=HYPERLINK(""x"")",\'+1,\'@SUM(A1),-5\r\n',
    );
  });

  it('datas em ISO; nulos vazios; sem linhas, texto vazio', () => {
    expect(toCsv([{ d: new Date('2026-10-08T12:00:00Z'), n: null }])).toBe(
      'd,n\r\n2026-10-08T12:00:00.000Z,\r\n',
    );
    expect(toCsv([])).toBe('');
  });
});

describe('RetentionService', () => {
  function setup(enabled: boolean, fail = false) {
    const query = jest.fn(() => (fail ? Promise.reject(new Error('boom')) : Promise.resolve([])));
    const values = { RETENTION_ENABLED: enabled, RETENTION_DAYS: 30 };
    const config = { get: (k: keyof typeof values) => values[k] } as unknown as ConfigService<
      Env,
      true
    >;
    return { service: new RetentionService(config, { query } as unknown as DataSource), query };
  }

  it('desligada: remove a política existente (o .env manda)', async () => {
    const { service, query } = setup(false);
    await service.onModuleInit();
    expect(query.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      expect.stringContaining('remove_retention_policy'),
    ]);
  });

  it('ligada: recria a política com o prazo atual', async () => {
    const { service, query } = setup(true);
    await service.onModuleInit();
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]).toEqual([expect.stringContaining('add_retention_policy'), [30]]);
  });

  it('falha no banco não derruba a subida', async () => {
    const { service } = setup(true, true);
    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });
});

describe('StorageStatsService', () => {
  /** Responde cada consulta pelo trecho de SQL que ela contém. */
  function ds(answers: [RegExp, unknown[]][]) {
    const query = jest.fn((sql: string) => {
      const hit = answers.find(([re]) => re.test(sql));
      return Promise.resolve(hit ? hit[1] : []);
    });
    return { query } as unknown as DataSource;
  }

  const base: [RegExp, unknown[]][] = [
    [/pg_size_pretty/, [{ size: '72 kB' }]],
    [
      /hypertable_compression_stats/,
      [{ compressed: '2', total: '5', before: '1000000', after: '100000' }],
    ],
    [
      /min\(time\)/,
      [{ oldest: new Date('2026-10-01T00:00:00Z'), newest: new Date('2026-10-08T00:00:00Z') }],
    ],
    [/FROM alarms/, [{ alarms: '7' }]],
    [/GROUP BY 1/, [{ source: 'sim', count: '100', tags: 4 }]],
    [/policy_retention/, [{ drop_after: '90 days' }]],
  ];

  it('conta exato em tabelas pequenas e calcula a economia da compressão', async () => {
    const stats = await new StorageStatsService(
      ds([
        [/approximate_row_count/, [{ approx: '500' }]],
        [/count\(\*\) AS n/, [{ n: '512' }]],
        ...base,
      ]),
    ).getStats();
    expect(stats).toMatchObject({
      measurementsRows: 512,
      measurementsRowsApproximate: false,
      hypertableSize: '72 kB',
      compression: {
        compressedChunks: 2,
        totalChunks: 5,
        savingsPct: 90,
        beforeSize: '976.6 kB',
        afterSize: '97.7 kB',
      },
      alarmRows: 7,
      bySourceLast24h: [{ source: 'sim', count: 100, tags: 4 }],
      retentionPolicy: { enabled: true, dropAfter: '90 days' },
    });
  });

  it('usa a estimativa em tabelas grandes (sem varrer tudo)', async () => {
    const fake = ds([[/approximate_row_count/, [{ approx: '5000000' }]], ...base]);
    const stats = await new StorageStatsService(fake).getStats();
    expect(stats).toMatchObject({ measurementsRows: 5_000_000, measurementsRowsApproximate: true });
    expect(
      (fake.query as jest.Mock).mock.calls.some((c: string[]) => /count\(\*\) AS n/.test(c[0])),
    ).toBe(false);
  });
});

describe('MetricsController.export', () => {
  const rows = [{ source: 'sim', tag: 'T', samples: 3, avg_value: 1.5 }];
  const storage = {
    exportSummary: jest.fn().mockResolvedValue(rows),
  } as unknown as StorageStatsService;
  const controller = new MetricsController(
    {} as MetricsCollectorService,
    storage,
    {} as RetentionService,
  );
  const res = () => ({ setHeader: jest.fn() }) as unknown as Response & { setHeader: jest.Mock };

  it('JSON por padrão, com 60 min', async () => {
    await expect(controller.export(res())).resolves.toEqual({ minutes: 60, rows });
  });

  it('CSV com BOM e cabeçalhos de download', async () => {
    const r = res();
    const csv = (await controller.export(r, '15', 'csv')) as string;
    expect(csv.startsWith('\uFEFFsource,tag,samples,avg_value\r\n')).toBe(true);
    expect(r.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
    expect(r.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="talos-resumo-15min.csv"',
    );
  });

  it.each([
    ['0', 'csv'],
    ['10081', 'csv'],
    ['abc', 'json'],
    ['60', 'xml'],
  ])('recusa minutes=%s format=%s', async (m, f) => {
    await expect(controller.export(res(), m, f)).rejects.toBeInstanceOf(BadRequestException);
  });
});
