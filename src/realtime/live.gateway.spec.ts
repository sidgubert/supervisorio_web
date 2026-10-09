import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Subject } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { AlarmEvent, AlarmsService } from '../alarms/alarms.service';
import { AuthService } from '../auth/auth.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { Sample } from '../ingestion/sample';
import { MetricsCollectorService } from '../metrics/metrics-collector.service';
import { LiveFeedService } from './live-feed.service';
import { LiveGateway, SubscribeAck } from './live.gateway';

/**
 * Sobe o gateway com socket.io de verdade (servidor numa porta livre e
 * clientes socket.io-client), com o LiveFeedService real e a ingestão e os
 * alarmes trocados por Subjects.
 */

const SECRET = 'x'.repeat(40);

const sample = (tag: string, value: number): Sample => ({
  time: new Date(),
  tag,
  value,
  quality: 192,
  source: 'sim',
  receivedAt: new Date(),
});

async function startApp(env: { flushMs: number; maxPerTag?: number; auth?: boolean }) {
  const feed = new Subject<Sample[]>();
  const alarmFeed = new Subject<AlarmEvent>();
  const values: Record<string, unknown> = {
    LIVE_FLUSH_MS: env.flushMs,
    LIVE_MAX_SAMPLES_PER_TAG: env.maxPerTag ?? 100,
    AUTH_ENABLED: env.auth ?? false,
    AUTH_USER: 'op',
    AUTH_PASSWORD: 'senha',
    AUTH_SECRET: SECRET,
  };
  const metrics = {
    wsConnected: jest.fn(),
    wsDisconnected: jest.fn(),
    wsSent: jest.fn(),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      LiveGateway,
      LiveFeedService,
      AuthService,
      { provide: ConfigService, useValue: { get: (k: string) => values[k] } },
      { provide: IngestionService, useValue: { samples$: feed } },
      { provide: AlarmsService, useValue: { events$: alarmFeed } },
      { provide: MetricsCollectorService, useValue: metrics },
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0);
  const url = (await app.getUrl()).replace('[::1]', 'localhost');
  return { app, url, feed, alarmFeed, metrics, auth: moduleRef.get(AuthService) };
}

describe('LiveGateway (socket.io)', () => {
  let ctx: Awaited<ReturnType<typeof startApp>>;
  const clients: Socket[] = [];

  async function connect(auth?: Record<string, string>): Promise<Socket> {
    const socket = io(`${ctx.url}/live`, { transports: ['websocket'], forceNew: true, auth });
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
    ctx = await startApp({ flushMs: 0 });
  });

  afterEach(() => {
    while (clients.length) clients.pop()!.disconnect();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('entrega só as tags assinadas', async () => {
    const c = await connect();
    const got = collector(c);
    await expect(send(c, 'subscribe', { tags: ['A'] })).resolves.toMatchObject({ ok: true });
    ctx.feed.next([sample('A', 1), sample('B', 2), sample('A', 3)]);
    const batches = await got();
    expect(batches).toHaveLength(1);
    expect(batches[0].map((s) => s.value)).toEqual([1, 3]);
  });

  it('sem tags assina todas, sem duplicar para quem também assinou a tag', async () => {
    const c = await connect();
    const got = collector(c);
    await send(c, 'subscribe', { tags: ['A'] });
    await send(c, 'subscribe');
    ctx.feed.next([sample('A', 1), sample('B', 2)]);
    const tags = (await got()).flat().map((s) => s.tag);
    expect(tags.sort()).toEqual(['A', 'B']);
  });

  it('no ack, devolve o último valor conhecido das tags assinadas', async () => {
    ctx.feed.next([sample('C', 10), sample('C', 11), sample('D', 20)]);
    const c = await connect();
    const ack = await send(c, 'subscribe', { tags: ['C', 'X'] });
    expect(ack).toMatchObject({ ok: true, tags: ['C', 'X'] });
    expect(ack.ok && ack.last.map((s) => s.value)).toEqual([11]);
  });

  it('sem clientes conectados, não transmite nem conta eventos', async () => {
    await new Promise((r) => setTimeout(r, 150)); // desconexões dos testes anteriores
    ctx.metrics.wsSent.mockClear();
    ctx.feed.next([sample('A', 1)]);
    ctx.alarmFeed.next({ type: 'raised', alarm: {} } as unknown as AlarmEvent);
    expect(ctx.metrics.wsSent).not.toHaveBeenCalled();
  });

  it('unsubscribe para a entrega', async () => {
    const c = await connect();
    const got = collector(c);
    await send(c, 'subscribe', { tags: ['A'] });
    await send(c, 'unsubscribe', { tags: ['A'] });
    ctx.feed.next([sample('A', 1)]);
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
    ctx.alarmFeed.next(event);
    await new Promise((r) => setTimeout(r, 150));
    expect(got.map((g) => g.map((e) => e.type))).toEqual([['raised'], ['raised']]);
  });

  it('conta clientes para as métricas', async () => {
    // Espera o servidor registrar as desconexões dos testes anteriores.
    await new Promise((r) => setTimeout(r, 150));
    ctx.metrics.wsConnected.mockClear();
    ctx.metrics.wsDisconnected.mockClear();
    const c = await connect();
    expect(ctx.metrics.wsConnected).toHaveBeenCalledTimes(1);
    c.disconnect();
    await new Promise((r) => setTimeout(r, 100));
    expect(ctx.metrics.wsDisconnected).toHaveBeenCalledTimes(1);
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
  let ctx: Awaited<ReturnType<typeof startApp>>;
  const socks: Socket[] = [];

  beforeAll(async () => {
    Logger.overrideLogger(false);
    ctx = await startApp({ flushMs: 100, maxPerTag: 3 });
  });

  afterAll(async () => {
    while (socks.length) socks.pop()!.disconnect();
    await ctx.app.close();
  });

  async function subscribedClient(tags?: string[]) {
    const socket = io(`${ctx.url}/live`, { transports: ['websocket'], forceNew: true });
    socks.push(socket);
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    const ack = (await socket
      .timeout(2000)
      .emitWithAck('subscribe', tags ? { tags } : {})) as SubscribeAck;
    const got: Sample[][] = [];
    socket.on('samples', (s: Sample[]) => got.push(s));
    return { got, ack };
  }

  it('lotes que chegam dentro da janela saem num único evento por tag', async () => {
    const { got } = await subscribedClient();
    ctx.feed.next([sample('A', 1)]);
    ctx.feed.next([sample('A', 2), sample('B', 10)]);
    ctx.feed.next([sample('A', 3)]);
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toEqual([]); // ainda dentro da janela
    await new Promise((r) => setTimeout(r, 200));
    const byTag = Object.fromEntries(got.map((b) => [b[0].tag, b.map((s) => s.value)]));
    expect(got).toHaveLength(2);
    expect(byTag).toEqual({ A: [1, 2, 3], B: [10] });
  });

  it('acima do teto por tag, mantém só as amostras mais recentes', async () => {
    const { got } = await subscribedClient();
    ctx.feed.next([1, 2, 3, 4, 5].map((v) => sample('C', v)));
    await new Promise((r) => setTimeout(r, 250));
    expect(got.map((b) => b.map((s) => s.value))).toEqual([[3, 4, 5]]);
  });

  it('o ack da assinatura já traz o último valor, sem esperar a janela', async () => {
    ctx.feed.next([sample('D', 7)]);
    const { ack } = await subscribedClient(['D']);
    expect(ack.ok && ack.last.map((s) => s.value)).toEqual([7]);
  });
});

describe('LiveGateway com autenticação', () => {
  let ctx: Awaited<ReturnType<typeof startApp>>;
  const socks: Socket[] = [];

  beforeAll(async () => {
    Logger.overrideLogger(false);
    ctx = await startApp({ flushMs: 0, auth: true });
  });

  afterAll(async () => {
    while (socks.length) socks.pop()!.disconnect();
    await ctx.app.close();
  });

  /** true se a conexão sobrevive; false se o servidor a derruba. */
  async function connects(auth?: Record<string, string>): Promise<boolean> {
    const socket = io(`${ctx.url}/live`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth,
    });
    socks.push(socket);
    return new Promise<boolean>((resolve) => {
      socket.once('disconnect', () => resolve(false));
      socket.once('connect', () => setTimeout(() => resolve(socket.connected), 200));
    });
  }

  it('recusa conexão sem token, com token inválido ou expirado', async () => {
    expect(await connects()).toBe(false);
    expect(await connects({ token: 'lixo.lixo' })).toBe(false);
    expect(await connects({ token: ctx.auth.sign('op', Date.now() - 1000) })).toBe(false);
  });

  it('aceita conexão com token válido', async () => {
    const { token } = ctx.auth.login('op', 'senha');
    expect(await connects({ token })).toBe(true);
  });
});
