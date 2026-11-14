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
import { AuthService } from '../auth/auth.service';
import { TagChange, TagsService } from '../tags/tags.service';
import { DashboardController, KEEPALIVE_MS } from './dashboard.controller';

const sample = (tag: string, value: number, time = new Date()): Sample => ({
  tag,
  value,
  time,
  quality: 192,
  source: 'sim',
  receivedAt: time,
});

/** Cadastro de tags do teste; o tempo real só repassa as que estão nele. */
const KNOWN = ['A', 'B', 'C'];

async function feed(flushMs = 0, maxPerTag = 100) {
  const samples = new Subject<Sample[]>();
  const values = { LIVE_FLUSH_MS: flushMs, LIVE_MAX_SAMPLES_PER_TAG: maxPerTag };
  const config = { get: (k: keyof typeof values) => values[k] } as unknown as ConfigService<
    Env,
    true
  >;
  const tags = { known: KNOWN, changes: new Subject<TagChange>() };
  const service = new LiveFeedService(
    { samples$: samples } as unknown as IngestionService,
    config,
    {
      findAll: () => Promise.resolve(tags.known.map((tag) => ({ tag }))),
      changes$: tags.changes,
    } as unknown as TagsService,
  );
  await service.onModuleInit();
  return { service, samples, tags };
}

describe('LiveFeedService', () => {
  afterEach(() => jest.useRealTimers());

  it('com LIVE_FLUSH_MS=0, repassa na hora, um lote por tag', async () => {
    const { service, samples } = await feed(0);
    const got: Sample[][][] = [];
    service.batches$.subscribe((b) => got.push(b));
    samples.next([sample('A', 1), sample('B', 2), sample('A', 3)]);
    expect(got).toHaveLength(1);
    expect(got[0].map((b) => b.map((s) => `${s.tag}=${s.value}`))).toEqual([
      ['A=1', 'A=3'],
      ['B=2'],
    ]);
  });

  it('agrupa a janela e respeita o teto por tag (mantém as mais recentes)', async () => {
    jest.useFakeTimers();
    const { service, samples } = await feed(200, 2);
    const got: Sample[][][] = [];
    service.batches$.subscribe((b) => got.push(b));
    samples.next([sample('A', 1)]);
    samples.next([sample('A', 2), sample('A', 3)]);
    expect(got).toHaveLength(0);
    jest.advanceTimersByTime(200);
    expect(got.map((g) => g.map((b) => b.map((s) => s.value)))).toEqual([[[2, 3]]]);
  });

  it('guarda o último valor de cada tag', async () => {
    const { service, samples } = await feed(0);
    samples.next([sample('A', 1), sample('A', 2), sample('B', 9)]);
    expect(service.lastValues(['A', 'X']).map((s) => s.value)).toEqual([2]);
    expect(
      service
        .lastValues()
        .map((s) => s.tag)
        .sort(),
    ).toEqual(['A', 'B']);
  });

  it('ignora tags fora do cadastro e esquece as que saem dele', async () => {
    const { service, samples, tags } = await feed(0);
    const got: Sample[][][] = [];
    service.batches$.subscribe((b) => got.push(b));
    samples.next([sample('A', 1), sample('SIM-0005.PV', 9)]);
    expect(got[0].map((b) => b[0].tag)).toEqual(['A']);
    expect(service.lastValues().map((s) => s.tag)).toEqual(['A']);

    tags.known = ['B'];
    tags.changes.next({ type: 'deleted', tag: { tag: 'A' } } as TagChange);
    await new Promise((r) => setImmediate(r));
    expect(service.lastValues()).toEqual([]);
    samples.next([sample('A', 2)]);
    expect(got).toHaveLength(1);
  });
});

describe('DashboardController', () => {
  async function setup() {
    const f = await feed(0);
    const alarmEvents = new Subject<AlarmEvent>();
    const t0 = new Date('2026-10-08T12:00:00Z');
    const measurements = {
      latestPerTag: jest.fn().mockResolvedValue([
        { tag: 'A', value: 1, time: t0, quality: 192, source: 'sim' },
        { tag: 'B', value: 5, time: new Date('2026-10-08T12:00:10Z'), quality: 192, source: 'sim' },
      ]),
    };
    const metrics = { sseConnected: jest.fn(), sseDisconnected: jest.fn(), sseSent: jest.fn() };
    const session = { valid: true };
    const controller = new DashboardController(
      measurements as unknown as MeasurementsService,
      { list: () => [{ id: 'x' }], events$: alarmEvents } as unknown as AlarmsService,
      { findAll: jest.fn().mockResolvedValue([{ tag: 'A' }]) } as unknown as TagsService,
      f.service,
      metrics as unknown as MetricsCollectorService,
      { validateToken: () => session.valid } as unknown as AuthService,
    );
    return { controller, samples: f.samples, alarmEvents, metrics, t0, session };
  }

  afterEach(() => jest.useRealTimers());

  it('tags: valor do banco, trocado pelo do tempo real quando este é mais novo', async () => {
    const { controller, samples, t0 } = await setup();
    samples.next([
      sample('A', 2, new Date(t0.getTime() + 5000)),
      sample('B', 4, t0),
      sample('C', 7),
      sample('SIM-0005.PV', 9), // fora do cadastro: não vai para o painel
    ]);
    const snap = await controller.tagsSnapshot();
    expect(snap.map((s) => `${s.tag}=${s.value}`)).toEqual(['A=2', 'B=5', 'C=7']);
  });

  it('alarms: alarmes abertos e o cadastro', async () => {
    await expect((await setup()).controller.alarmsSnapshot()).resolves.toEqual({
      alarms: [{ id: 'x' }],
      tags: [{ tag: 'A' }],
    });
  });

  it('stream: amostras, alarmes e ping; conta o cliente e libera ao desconectar', async () => {
    jest.useFakeTimers();
    const { controller, samples, alarmEvents, metrics } = await setup();
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

  it('stream: encerra no ping seguinte quando o token deixa de valer', async () => {
    jest.useFakeTimers();
    const { controller, metrics, session } = await setup();
    const got: MessageEvent[] = [];
    let done = false;
    controller.stream().subscribe({ next: (e) => got.push(e), complete: () => (done = true) });

    jest.advanceTimersByTime(KEEPALIVE_MS);
    expect(done).toBe(false);
    session.valid = false; // usuário desativado, senha trocada ou token vencido
    jest.advanceTimersByTime(KEEPALIVE_MS);
    expect(done).toBe(true);
    expect(got).toHaveLength(1); // só o primeiro ping
    expect(metrics.sseDisconnected).toHaveBeenCalledTimes(1);
  });
});
