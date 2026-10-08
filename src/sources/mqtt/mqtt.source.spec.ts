import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createBroker } from 'aedes';
import { AddressInfo, createServer, Server } from 'net';
import { connectAsync, MqttClient } from 'mqtt';
import { Subject } from 'rxjs';
import { Env } from '../../config/env.validation';
import { IngestionService } from '../../ingestion/ingestion.service';
import { SampleInput } from '../../ingestion/sample';
import { Tag } from '../../tags/tag.entity';
import { TagChange, TagsService } from '../../tags/tags.service';
import { MqttSource } from './mqtt.source';

/**
 * Testa a fonte contra um broker MQTT de verdade (aedes, em memória), numa
 * porta livre: conexão, assinaturas, payloads, cadastro dinâmico, broker fora
 * do ar na subida e reconexão.
 */

/** Broker aedes numa porta (0 = livre). */
async function startBroker(port = 0) {
  const broker = createBroker();
  const server: Server = createServer((socket) => broker.handle(socket));
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const close = async () => {
    await new Promise<void>((resolve) => broker.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { port: (server.address() as AddressInfo).port, close };
}

/** Uma porta livre agora (para subir o broker só depois). */
async function freePort() {
  const b = await startBroker();
  await b.close();
  return b.port;
}

async function waitFor(cond: () => boolean, timeoutMs = 4000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('condição não atingida a tempo');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const tag = (name: string, address: string | null, extra: Partial<Tag> = {}) =>
  ({ tag: name, source: 'mqtt', address, enabled: true, ...extra }) as Tag;

function setup(port: number, initialTags: Tag[], enabled = true) {
  let tags = initialTags;
  const changes = new Subject<TagChange>();
  const tagsService = {
    registerAddressValidator: jest.fn(),
    findEnabledBySource: jest.fn(() => Promise.resolve(tags.filter((t) => t.enabled))),
    changes$: changes,
  };
  const ingestion = { register: jest.fn() };
  const values = {
    MQTT_ENABLED: enabled,
    MQTT_URL: `mqtt://127.0.0.1:${port}`,
    MQTT_USERNAME: '',
    MQTT_PASSWORD: '',
  };
  const config = {
    get: (k: keyof typeof values) => values[k],
  } as unknown as ConfigService<Env, true>;
  const source = new MqttSource(
    config,
    ingestion as unknown as IngestionService,
    tagsService as unknown as TagsService,
  );
  (source as any).reconnectMs = 100;
  const received: SampleInput[] = [];
  const emit = (s: SampleInput[]) => received.push(...s);

  /** Troca o cadastro e avisa como o TagsService avisaria. */
  const setTags = (next: Tag[], change: TagChange) => {
    tags = next;
    changes.next(change);
  };
  return { source, tagsService, ingestion, received, emit, setTags };
}

describe('MqttSource', () => {
  let broker: Awaited<ReturnType<typeof startBroker>> | undefined;
  let source: MqttSource | undefined;
  let publisher: MqttClient | undefined;

  beforeAll(() => Logger.overrideLogger(false));

  afterEach(async () => {
    await publisher?.endAsync();
    await source?.stop();
    await broker?.close();
    publisher = source = broker = undefined;
  });

  async function connectedSetup(initialTags: Tag[]) {
    broker = await startBroker();
    const ctx = setup(broker.port, initialTags);
    source = ctx.source;
    await source.start(ctx.emit);
    await waitFor(() => source!.status().connected === true);
    publisher = await connectAsync(`mqtt://127.0.0.1:${broker.port}`);
    // Dá tempo de o broker registrar as assinaturas feitas no 'connect'.
    await new Promise((r) => setTimeout(r, 100));
    return ctx;
  }

  it('onModuleInit: registra o validador sempre e a fonte só se habilitada', () => {
    const on = setup(1, []);
    on.source.onModuleInit();
    expect(on.tagsService.registerAddressValidator).toHaveBeenCalledWith(
      'mqtt',
      expect.any(Function),
    );
    expect(on.ingestion.register).toHaveBeenCalledWith(on.source);

    const off = setup(1, [], false);
    off.source.onModuleInit();
    expect(off.tagsService.registerAddressValidator).toHaveBeenCalled();
    expect(off.ingestion.register).not.toHaveBeenCalled();
  });

  it('converte as mensagens dos tópicos cadastrados em amostras', async () => {
    const ctx = await connectedSetup([tag('TT-1', 'planta/tt1'), tag('XV-1', 'planta/xv1')]);
    expect(source!.status()).toMatchObject({ connected: true, tags: 2 });

    await publisher!.publishAsync('planta/tt1', '21.5', { qos: 1 });
    await publisher!.publishAsync(
      'planta/tt1',
      JSON.stringify({ value: 22, time: '2026-10-08T12:00:00Z', quality: 64 }),
      { qos: 1 },
    );
    await publisher!.publishAsync('planta/xv1', 'true', { qos: 1 });
    await waitFor(() => ctx.received.length === 3);

    expect(ctx.received).toEqual([
      { tag: 'TT-1', value: 21.5 },
      { tag: 'TT-1', value: 22, time: new Date('2026-10-08T12:00:00Z'), quality: 64 },
      { tag: 'XV-1', value: 1 },
    ]);
  });

  it('ignora tópicos não cadastrados e payloads inválidos', async () => {
    const ctx = await connectedSetup([tag('TT-1', 'planta/tt1')]);
    await publisher!.publishAsync('outro/topico', '1', { qos: 1 });
    await publisher!.publishAsync('planta/tt1', 'não é número', { qos: 1 });
    await publisher!.publishAsync('planta/tt1', '5', { qos: 1 });
    await waitFor(() => ctx.received.length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(ctx.received).toEqual([{ tag: 'TT-1', value: 5 }]);
  });

  it('ignora tags com tópico inválido ou repetido no cadastro', async () => {
    await connectedSetup([
      tag('A', 'planta/a'),
      tag('B', 'planta/+'),
      tag('C', null),
      tag('D', 'planta/a'),
    ]);
    expect(source!.status().tags).toBe(1);
  });

  it('acompanha o cadastro: assina tópicos de tags novas e larga os removidos', async () => {
    const t1 = tag('TT-1', 'planta/tt1');
    const t2 = tag('TT-2', 'planta/tt2');
    const ctx = await connectedSetup([t1]);

    ctx.setTags([t1, t2], { type: 'created', tag: t2 });
    await waitFor(() => source!.status().tags === 2);
    await new Promise((r) => setTimeout(r, 100));
    await publisher!.publishAsync('planta/tt2', '2', { qos: 1 });
    await waitFor(() => ctx.received.length === 1);

    ctx.setTags([t2], { type: 'deleted', tag: t1 });
    await waitFor(() => source!.status().tags === 1);
    await new Promise((r) => setTimeout(r, 100));
    await publisher!.publishAsync('planta/tt1', '1', { qos: 1 });
    await publisher!.publishAsync('planta/tt2', '3', { qos: 1 });
    await waitFor(() => ctx.received.length === 2);
    expect(ctx.received.map((s) => s.tag)).toEqual(['TT-2', 'TT-2']);
  });

  it('ignora alterações de tags de outras fontes', async () => {
    const ctx = await connectedSetup([tag('TT-1', 'planta/tt1')]);
    const modbus = tag('PT-1', '1/hr/0', { source: 'modbus' });
    ctx.setTags([tag('TT-1', 'planta/tt1'), modbus], { type: 'created', tag: modbus });
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx.tagsService.findEnabledBySource).toHaveBeenCalledTimes(1);
  });

  it('com o broker fora na subida, não trava e conecta quando ele aparece', async () => {
    const port = await freePort();
    const ctx = setup(port, [tag('TT-1', 'planta/tt1')]);
    source = ctx.source;

    const t0 = Date.now();
    await source.start(ctx.emit);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(source.status().connected).toBe(false);

    broker = await startBroker(port);
    await waitFor(() => source!.status().connected === true);
    await new Promise((r) => setTimeout(r, 100));
    publisher = await connectAsync(`mqtt://127.0.0.1:${port}`);
    await publisher.publishAsync('planta/tt1', '42', { qos: 1 });
    await waitFor(() => ctx.received.length === 1);
    expect(ctx.received[0]).toEqual({ tag: 'TT-1', value: 42 });
  });

  it('reconecta e reassina depois de o broker cair e voltar', async () => {
    const ctx = await connectedSetup([tag('TT-1', 'planta/tt1')]);
    const port = broker!.port;
    await publisher!.endAsync();
    publisher = undefined;
    await broker!.close();
    broker = undefined;
    await waitFor(() => source!.status().connected === false);

    broker = await startBroker(port);
    await waitFor(() => source!.status().connected === true);
    await new Promise((r) => setTimeout(r, 100));
    publisher = await connectAsync(`mqtt://127.0.0.1:${port}`);
    await publisher.publishAsync('planta/tt1', '7', { qos: 1 });
    await waitFor(() => ctx.received.length === 1);
  });

  it('depois de stop não emite mais', async () => {
    const ctx = await connectedSetup([tag('TT-1', 'planta/tt1')]);
    await source!.stop();
    source = undefined;
    await publisher!.publishAsync('planta/tt1', '1', { qos: 1 });
    await new Promise((r) => setTimeout(r, 100));
    expect(ctx.received).toEqual([]);
  });
});
