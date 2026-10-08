import { INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Subject } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { IngestionService } from '../ingestion/ingestion.service';
import { Sample } from '../ingestion/sample';
import { AlarmEvent, AlarmsService } from '../alarms/alarms.service';
import { LiveGateway, SubscribeAck } from './live.gateway';

/** ConfigService falso com a janela de envio do gateway. */
const liveConfig = (flushMs: number, maxPerTag = 100) => ({
  provide: ConfigService,
  useValue: {
    get: (k: string) => ({ LIVE_FLUSH_MS: flushMs, LIVE_MAX_SAMPLES_PER_TAG: maxPerTag })[k],
  },
});

/**
 * Sobe o gateway com socket.io de verdade (servidor numa porta livre e
 * clientes socket.io-client), trocando só a ingestão por um Subject.
 * Aqui o envio é imediato (LIVE_FLUSH_MS = 0); o agrupamento é testado abaixo.
 */
describe('LiveGateway (socket.io)', () => {
  let app: INestApplication;
  let url: string;
  const feed = new Subject<Sample[]>();
  const alarmFeed = new Subject<AlarmEvent>();
  const clients: Socket[] = [];

  const sample = (tag: string, value: number): Sample => ({
    time: new Date(),
    tag,
    value,
    quality: 192,
    source: 'sim',
    receivedAt: new Date(),
  });

  async function connect(): Promise<Socket> {
    const socket = io(`${url}/live`, { transports: ['websocket'], forceNew: true });
    clients.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    return socket;
  }

  const send = (socket: Socket, event: string, body?: unknown) =>
    socket.timeout(2000).emitWithAck(event, body) as Promise<SubscribeAck>;

  /** Coleta os eventos 'samples' recebidos até agora (após um respiro de rede). */
  function collector(socket: Socket) {
    const got: Sample[][] = [];
    socket.on('samples', (s: Sample[]) => got.push(s));
    return async () => {
      await new Promise((r) => setTimeout(r, 150));
      return got;
    };
  }

  beforeAll(async () => {
    Logger.overrideLogger(false);
    const moduleRef = await Test.createTestingModule({
      providers: [
        LiveGateway,
        { provide: IngestionService, useValue: { samples$: feed } },
        { provide: AlarmsService, useValue: { events$: alarmFeed } },
        liveConfig(0),
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    url = await app.getUrl();
    url = url.replace('[::1]', 'localhost');
  });

  afterEach(() => {
    while (clients.length) clients.pop()!.disconnect();
  });

  afterAll(async () => {
    await app.close();
  });

  it('entrega só as tags assinadas', async () => {
    const c = await connect();
    const got = collector(c);
    await expect(send(c, 'subscribe', { tags: ['A'] })).resolves.toMatchObject({ ok: true });
    feed.next([sample('A', 1), sample('B', 2), sample('A', 3)]);
    const batches = await got();
    expect(batches).toHaveLength(1);
    expect(batches[0].map((s) => s.value)).toEqual([1, 3]);
  });

  it('sem tags assina todas, sem duplicar para quem também assinou a tag', async () => {
    const c = await connect();
    const got = collector(c);
    await send(c, 'subscribe', { tags: ['A'] });
    await send(c, 'subscribe');
    feed.next([sample('A', 1), sample('B', 2)]);
    const batches = await got();
    expect(
      batches
        .flat()
        .map((s) => s.tag)
        .sort(),
    ).toEqual(['A', 'B']);
  });

  it('no ack, devolve o último valor conhecido das tags assinadas', async () => {
    feed.next([sample('C', 10), sample('C', 11), sample('D', 20)]);
    const c = await connect();
    const ack = await send(c, 'subscribe', { tags: ['C', 'X'] });
    expect(ack).toMatchObject({ ok: true, tags: ['C', 'X'] });
    expect(ack.ok && ack.last.map((s) => s.value)).toEqual([11]);
  });

  it('unsubscribe para a entrega', async () => {
    const c = await connect();
    const got = collector(c);
    await send(c, 'subscribe', { tags: ['A'] });
    await send(c, 'unsubscribe', { tags: ['A'] });
    feed.next([sample('A', 1)]);
    expect(await got()).toHaveLength(0);
  });

  it('envia os eventos de alarme a todos os clientes, mesmo sem assinatura', async () => {
    const c1 = await connect();
    const c2 = await connect();
    await send(c1, 'subscribe', { tags: ['OUTRA'] });
    const got: AlarmEvent[][] = [[], []];
    c1.on('alarm', (e: AlarmEvent) => got[0].push(e));
    c2.on('alarm', (e: AlarmEvent) => got[1].push(e));
    const event = {
      type: 'raised',
      alarm: { id: 'x', tag: 'A', level: 'H', state: 'ACTIVE_UNACKED' },
    } as unknown as AlarmEvent;
    alarmFeed.next(event);
    await new Promise((r) => setTimeout(r, 150));
    expect(got.map((g) => g.map((e) => e.type))).toEqual([['raised'], ['raised']]);
  });

  it.each([[{ tags: 'A' }], [{ tags: [1, 2] }], [{ tags: [''] }], ['texto']])(
    'rejeita payload inválido %j',
    async (body) => {
      const c = await connect();
      await expect(send(c, 'subscribe', body)).resolves.toMatchObject({ ok: false });
    },
  );
});

describe('LiveGateway: envio agrupado (LIVE_FLUSH_MS)', () => {
  let app: INestApplication;
  let url: string;
  const feed = new Subject<Sample[]>();
  const socks: Socket[] = [];
  const sample = (tag: string, value: number): Sample => ({
    time: new Date(),
    tag,
    value,
    quality: 192,
    source: 'sim',
    receivedAt: new Date(),
  });

  beforeAll(async () => {
    Logger.overrideLogger(false);
    const moduleRef = await Test.createTestingModule({
      providers: [
        LiveGateway,
        { provide: IngestionService, useValue: { samples$: feed } },
        { provide: AlarmsService, useValue: { events$: new Subject<AlarmEvent>() } },
        liveConfig(100, 3),
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    url = (await app.getUrl()).replace('[::1]', 'localhost');
  });

  afterAll(async () => {
    while (socks.length) socks.pop()!.disconnect();
    await app.close();
  });

  async function subscribedClient() {
    const socket = io(`${url}/live`, { transports: ['websocket'], forceNew: true });
    socks.push(socket);
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    await socket.timeout(2000).emitWithAck('subscribe', {});
    const got: Sample[][] = [];
    socket.on('samples', (s: Sample[]) => got.push(s));
    return { socket, got };
  }

  it('lotes que chegam dentro da janela saem num único evento por tag', async () => {
    const { got } = await subscribedClient();
    feed.next([sample('A', 1)]);
    feed.next([sample('A', 2), sample('B', 10)]);
    feed.next([sample('A', 3)]);
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toEqual([]); // ainda dentro da janela
    await new Promise((r) => setTimeout(r, 200));
    const byTag = Object.fromEntries(got.map((batch) => [batch[0].tag, batch.map((s) => s.value)]));
    expect(got).toHaveLength(2);
    expect(byTag).toEqual({ A: [1, 2, 3], B: [10] });
  });

  it('acima do teto por tag, mantém só as amostras mais recentes', async () => {
    const { got } = await subscribedClient();
    feed.next([1, 2, 3, 4, 5].map((v) => sample('C', v)));
    await new Promise((r) => setTimeout(r, 250));
    expect(got.map((batch) => batch.map((s) => s.value))).toEqual([[3, 4, 5]]);
  });

  it('o ack da assinatura já traz o último valor, sem esperar a janela', async () => {
    feed.next([sample('D', 7)]);
    const socket = io(`${url}/live`, { transports: ['websocket'], forceNew: true });
    socks.push(socket);
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    const ack = (await socket
      .timeout(2000)
      .emitWithAck('subscribe', { tags: ['D'] })) as SubscribeAck;
    expect(ack.ok && ack.last.map((s) => s.value)).toEqual([7]);
  });
});
