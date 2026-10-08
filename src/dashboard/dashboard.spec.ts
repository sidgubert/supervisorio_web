import { MessageEvent } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Subject } from 'rxjs';
import { AlarmEvent, AlarmsService } from '../alarms/alarms.service';
import { Env } from '../config/env.validation';
import { IngestionService } from '../ingestion/ingestion.service';
import { Sample } from '../ingestion/sample';
import { MeasurementsService } from '../measurements/measurements.service';
import { MetricsCollectorService } from '../metrics/metrics-collector.service';
import { LiveFeedService } from '../realtime/live-feed.service';
import { TagsService } from '../tags/tags.service';
import { DashboardController, KEEPALIVE_MS } from './dashboard.controller';

const sample = (tag: string, value: number, time = new Date()): Sample => ({
  tag,
  value,
  time,
  quality: 192,
  source: 'sim',
  receivedAt: time,
});

function feed(flushMs = 0, maxPerTag = 100) {
  const samples = new Subject<Sample[]>();
  const values = { LIVE_FLUSH_MS: flushMs, LIVE_MAX_SAMPLES_PER_TAG: maxPerTag };
  const config = { get: (k: keyof typeof values) => values[k] } as unknown as ConfigService<
    Env,
    true
  >;
  const service = new LiveFeedService({ samples$: samples } as unknown as IngestionService, config);
  service.onModuleInit();
  return { service, samples };
}

describe('LiveFeedService', () => {
  afterEach(() => jest.useRealTimers());

  it('com LIVE_FLUSH_MS=0, repassa na hora, um lote por tag', () => {
    const { service, samples } = feed(0);
    const got: Sample[][][] = [];
    service.batches$.subscribe((b) => got.push(b));
    samples.next([sample('A', 1), sample('B', 2), sample('A', 3)]);
    expect(got).toHaveLength(1);
    expect(got[0].map((b) => b.map((s) => `${s.tag}=${s.value}`))).toEqual([
      ['A=1', 'A=3'],
      ['B=2'],
    ]);
  });

  it('agrupa a janela e respeita o teto por tag (mantém as mais recentes)', () => {
    jest.useFakeTimers();
    const { service, samples } = feed(200, 2);
    const got: Sample[][][] = [];
    service.batches$.subscribe((b) => got.push(b));
    samples.next([sample('A', 1)]);
    samples.next([sample('A', 2), sample('A', 3)]);
    expect(got).toHaveLength(0);
    jest.advanceTimersByTime(200);
    expect(got.map((g) => g.map((b) => b.map((s) => s.value)))).toEqual([[[2, 3]]]);
  });

  it('guarda o último valor de cada tag', () => {
    const { service, samples } = feed(0);
    samples.next([sample('A', 1), sample('A', 2), sample('B', 9)]);
    expect(service.lastValues(['A', 'X']).map((s) => s.value)).toEqual([2]);
    expect(
      service
        .lastValues()
        .map((s) => s.tag)
        .sort(),
    ).toEqual(['A', 'B']);
  });
});

describe('DashboardController', () => {
  function setup() {
    const f = feed(0);
    const alarmEvents = new Subject<AlarmEvent>();
    const t0 = new Date('2026-10-08T12:00:00Z');
    const measurements = {
      latestPerTag: jest.fn().mockResolvedValue([
        { tag: 'A', value: 1, time: t0, quality: 192, source: 'sim' },
        { tag: 'B', value: 5, time: new Date('2026-10-08T12:00:10Z'), quality: 192, source: 'sim' },
      ]),
    };
    const metrics = { sseConnected: jest.fn(), sseDisconnected: jest.fn(), sseSent: jest.fn() };
    const controller = new DashboardController(
      measurements as unknown as MeasurementsService,
      { list: () => [{ id: 'x' }], events$: alarmEvents } as unknown as AlarmsService,
      { findAll: jest.fn().mockResolvedValue([{ tag: 'A' }]) } as unknown as TagsService,
      f.service,
      metrics as unknown as MetricsCollectorService,
    );
    return { controller, samples: f.samples, alarmEvents, metrics, t0 };
  }

  afterEach(() => jest.useRealTimers());

  it('tags: valor do banco, trocado pelo do tempo real quando este é mais novo', async () => {
    const { controller, samples, t0 } = setup();
    samples.next([
      sample('A', 2, new Date(t0.getTime() + 5000)),
      sample('B', 4, t0),
      sample('C', 7),
    ]);
    const snap = await controller.tagsSnapshot();
    expect(snap.map((s) => `${s.tag}=${s.value}`)).toEqual(['A=2', 'B=5', 'C=7']);
  });

  it('alarms: alarmes abertos e o cadastro', async () => {
    await expect(setup().controller.alarmsSnapshot()).resolves.toEqual({
      alarms: [{ id: 'x' }],
      tags: [{ tag: 'A' }],
    });
  });

  it('stream: amostras, alarmes e ping; conta o cliente e libera ao desconectar', () => {
    jest.useFakeTimers();
    const { controller, samples, alarmEvents, metrics } = setup();
    const got: MessageEvent[] = [];
    const sub = controller.stream().subscribe((e) => got.push(e));
    expect(metrics.sseConnected).toHaveBeenCalledTimes(1);

    const t = new Date('2026-10-08T12:00:00Z');
    samples.next([sample('A', 1, t)]);
    alarmEvents.next({ type: 'raised', alarm: { id: 'x' } } as unknown as AlarmEvent);
    jest.advanceTimersByTime(KEEPALIVE_MS);

    expect(got.map((e) => e.data)).toEqual([
      { type: 'sample', tag: 'A', value: 1, quality: 192, source: 'sim', time: t },
      { type: 'alarm', change: 'raised', alarm: { id: 'x' } },
      { type: 'ping' },
    ]);
    expect(metrics.sseSent).toHaveBeenCalledWith(1);

    sub.unsubscribe();
    expect(metrics.sseDisconnected).toHaveBeenCalledTimes(1);
    samples.next([sample('A', 2)]);
    expect(got).toHaveLength(3); // nada depois de desconectar
  });
});
