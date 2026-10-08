import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Subject } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { IngestionService } from '../ingestion/ingestion.service';
import { Sample } from '../ingestion/sample';
import { LiveGateway, SubscribeAck } from './live.gateway';

/**
 * Sobe o gateway com socket.io de verdade (servidor numa porta livre e
 * clientes socket.io-client), trocando só a ingestão por um Subject.
 */
describe('LiveGateway (socket.io)', () => {
  let app: INestApplication;
  let url: string;
  const feed = new Subject<Sample[]>();
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
      providers: [LiveGateway, { provide: IngestionService, useValue: { samples$: feed } }],
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

  it.each([[{ tags: 'A' }], [{ tags: [1, 2] }], [{ tags: [''] }], ['texto']])(
    'rejeita payload inválido %j',
    async (body) => {
      const c = await connect();
      await expect(send(c, 'subscribe', body)).resolves.toMatchObject({ ok: false });
    },
  );
});
