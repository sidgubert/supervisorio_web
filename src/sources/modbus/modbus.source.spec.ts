import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServerTCP } from 'modbus-serial';
import { AddressInfo, createServer } from 'net';
import { Subject } from 'rxjs';
import { Env } from '../../config/env.validation';
import { IngestionService } from '../../ingestion/ingestion.service';
import { QUALITY_BAD, SampleInput } from '../../ingestion/sample';
import { Tag } from '../../tags/tag.entity';
import { TagChange, TagsService } from '../../tags/tags.service';
import { ModbusSource } from './modbus.source';

/**
 * Testa a fonte contra um equipamento Modbus TCP de verdade (o ServerTCP do
 * modbus-serial), numa porta livre.
 */

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** "CLP" simulado: mapas de registradores/bits editáveis pelo teste. */
async function startDevice(port: number) {
  const hr = new Map<number, number>();
  const ir = new Map<number, number>();
  const coils = new Map<number, boolean>();
  /** Holding registers a partir deste endereço respondem "illegal data address". */
  let hrLimit = 100;
  let requests = 0;
  const illegal = () => Object.assign(new Error('Illegal data address'), { modbusErrorCode: 2 });
  const vector = {
    getHoldingRegister: (a: number) => {
      requests++;
      if (a >= hrLimit) throw illegal();
      return hr.get(a) ?? 0;
    },
    getMultipleHoldingRegisters: (a: number, len: number) => {
      requests++;
      if (a + len > hrLimit) throw illegal();
      return Array.from({ length: len }, (_, i) => hr.get(a + i) ?? 0);
    },
    getInputRegister: (a: number) => ir.get(a) ?? 0,
    getCoil: (a: number) => coils.get(a) ?? false,
    getDiscreteInput: () => true,
  };
  const server = new ServerTCP(vector, { host: '127.0.0.1', port, unitID: 255 });
  await new Promise<void>((resolve) => server.on('initialized', () => resolve()));
  return {
    hr,
    ir,
    coils,
    setHrLimit: (n: number) => (hrLimit = n),
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const sock of server.socks.keys()) sock.destroy();
        server.close(() => resolve());
      }),
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 4000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('condição não atingida a tempo');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const tag = (name: string, address: string, extra: Partial<Tag> = {}) =>
  ({ tag: name, source: 'modbus', address, enabled: true, ...extra }) as Tag;

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
    MODBUS_ENABLED: enabled,
    MODBUS_HOST: '127.0.0.1',
    MODBUS_PORT: port,
    MODBUS_POLL_MS: 50,
    MODBUS_TIMEOUT_MS: 300,
  };
  const config = {
    get: (k: keyof typeof values) => values[k],
  } as unknown as ConfigService<Env, true>;
  const source = new ModbusSource(
    config,
    ingestion as unknown as IngestionService,
    tagsService as unknown as TagsService,
  );
  const received: SampleInput[] = [];
  const emit = (s: SampleInput[]) => received.push(...s);
  const setTags = (next: Tag[], change: TagChange) => {
    tags = next;
    changes.next(change);
  };
  return { source, tagsService, ingestion, received, emit, setTags };
}

/** Amostras recebidas de uma tag. */
const of = (received: SampleInput[], name: string) => received.filter((s) => s.tag === name);

describe('ModbusSource', () => {
  let device: Awaited<ReturnType<typeof startDevice>> | undefined;
  let source: ModbusSource | undefined;

  beforeAll(() => Logger.overrideLogger(false));

  afterEach(async () => {
    await source?.stop();
    await device?.close();
    source = device = undefined;
  });

  async function running(tags: Tag[]) {
    const port = await freePort();
    device = await startDevice(port);
    const ctx = setup(port, tags);
    source = ctx.source;
    return { ...ctx, port };
  }

  it('onModuleInit: registra o validador sempre e a fonte só se habilitada', () => {
    const on = setup(1, []);
    on.source.onModuleInit();
    expect(on.tagsService.registerAddressValidator).toHaveBeenCalledWith(
      'modbus',
      expect.any(Function),
    );
    expect(on.ingestion.register).toHaveBeenCalledWith(on.source);

    const off = setup(1, [], false);
    off.source.onModuleInit();
    expect(off.ingestion.register).not.toHaveBeenCalled();
  });

  it('lê registradores e bits e converte pelos tipos do endereço', async () => {
    const ctx = await running([
      tag('PT-1', 'hr:0?scale=0.01'),
      tag('TT-1', 'hr:1?type=int16&scale=0.1'),
      tag('FT-1', 'hr:2?type=float32'),
      tag('LT-1', 'ir:5'),
      tag('XV-1', 'coil:0'),
      tag('ZS-1', 'di:3'),
    ]);
    const f = Buffer.alloc(4);
    f.writeFloatBE(12.5, 0);
    device!.hr.set(0, 425).set(1, 65526).set(2, f.readUInt16BE(0)).set(3, f.readUInt16BE(2));
    device!.ir.set(5, 77);
    device!.coils.set(0, true);

    await ctx.source.start(ctx.emit);
    await waitFor(() => ctx.received.length >= 6);
    const first = Object.fromEntries(ctx.received.slice(0, 6).map((s) => [s.tag, s.value]));
    expect(first['PT-1']).toBeCloseTo(4.25);
    expect(first['TT-1']).toBeCloseTo(-1);
    expect(first).toMatchObject({ 'FT-1': 12.5, 'LT-1': 77, 'XV-1': 1, 'ZS-1': 1 });
    expect(ctx.received[0].time).toBeUndefined(); // Modbus não tem horário: vale o de recebimento
    expect(ctx.source.status()).toMatchObject({ connected: true, tags: 6 });
  });

  it('lê registradores contíguos num só request por ciclo', async () => {
    const ctx = await running([tag('A', 'hr:0'), tag('B', 'hr:1'), tag('C', 'hr:2?type=float32')]);
    await ctx.source.start(ctx.emit);
    await waitFor(() => ctx.received.length >= 6); // 2 ciclos
    await ctx.source.stop();
    const cycles = ctx.received.length / 3;
    expect(device!.requests()).toBe(cycles);
  });

  it('exceção do equipamento: só o bloco afetado falha, com uma amostra Bad', async () => {
    const ctx = await running([tag('OK', 'ir:0'), tag('X', 'hr:50')]);
    device!.hr.set(50, 7);
    device!.ir.set(0, 1);
    await ctx.source.start(ctx.emit);
    await waitFor(() => of(ctx.received, 'X').length >= 1);

    device!.setHrLimit(10); // hr:50 passa a responder "illegal data address"
    await waitFor(() => of(ctx.received, 'X').some((s) => s.quality === QUALITY_BAD));
    const okBefore = of(ctx.received, 'OK').length;
    await waitFor(() => of(ctx.received, 'OK').length >= okBefore + 3); // outro bloco segue lendo

    const bad = of(ctx.received, 'X').filter((s) => s.quality === QUALITY_BAD);
    expect(bad).toEqual([{ tag: 'X', value: 7, quality: QUALITY_BAD }]); // uma só, com o último valor
    expect(ctx.source.status().detail).toMatch(/1 tag\(s\) sem leitura/);

    device!.setHrLimit(100);
    device!.hr.set(50, 8);
    await waitFor(() => of(ctx.received, 'X').at(-1)?.value === 8);
    expect(of(ctx.received, 'X').at(-1)).toEqual({ tag: 'X', value: 8 });
    expect(ctx.source.status().detail).not.toMatch(/sem leitura/);
  });

  it('equipamento fora na subida: não trava e começa a ler quando ele aparece', async () => {
    const port = await freePort();
    const ctx = setup(port, [tag('A', 'hr:0')]);
    source = ctx.source;
    const t0 = Date.now();
    await source.start(ctx.emit);
    expect(Date.now() - t0).toBeLessThan(500);
    await new Promise((r) => setTimeout(r, 200));
    expect(source.status().connected).toBe(false);
    expect(ctx.received).toEqual([]); // sem valor anterior, nada a marcar como Bad

    device = await startDevice(port);
    device.hr.set(0, 5);
    await waitFor(() => ctx.received.length >= 1);
    expect(ctx.received[0]).toEqual({ tag: 'A', value: 5 });
  });

  it('conexão perdida: uma amostra Bad por tag e reconexão automática', async () => {
    const ctx = await running([tag('A', 'hr:0'), tag('B', 'coil:0')]);
    device!.hr.set(0, 3);
    await ctx.source.start(ctx.emit);
    await waitFor(() => ctx.received.length >= 2);

    const port = ctx.port;
    await device!.close();
    device = undefined;
    await waitFor(() => ctx.received.filter((s) => s.quality === QUALITY_BAD).length === 2);
    await new Promise((r) => setTimeout(r, 300)); // vários ciclos sem conexão
    expect(ctx.received.filter((s) => s.quality === QUALITY_BAD)).toEqual([
      { tag: 'A', value: 3, quality: QUALITY_BAD },
      { tag: 'B', value: 0, quality: QUALITY_BAD },
    ]);
    expect(ctx.source.status().connected).toBe(false);

    device = await startDevice(port);
    device.hr.set(0, 9);
    await waitFor(() => of(ctx.received, 'A').at(-1)?.value === 9);
    expect(ctx.source.status().connected).toBe(true);
  });

  it('acompanha o cadastro de tags', async () => {
    const a = tag('A', 'hr:0');
    const b = tag('B', 'hr:10');
    const ctx = await running([a]);
    device!.hr.set(10, 42);
    await ctx.source.start(ctx.emit);
    await waitFor(() => ctx.received.length >= 1);

    ctx.setTags([a, b], { type: 'created', tag: b });
    await waitFor(() => of(ctx.received, 'B').length >= 1);
    expect(of(ctx.received, 'B')[0].value).toBe(42);

    ctx.setTags([b], { type: 'deleted', tag: a });
    await waitFor(() => ctx.source.status().tags === 1);
    const countA = of(ctx.received, 'A').length;
    await new Promise((r) => setTimeout(r, 200));
    expect(of(ctx.received, 'A').length).toBe(countA);
  });

  it('ignora tags com endereço inválido no cadastro', async () => {
    const ctx = await running([tag('A', 'hr:0'), tag('B', 'xx:1'), tag('C', '')]);
    await ctx.source.start(ctx.emit);
    expect(ctx.source.status().tags).toBe(1);
  });

  it('depois de stop não emite mais', async () => {
    const ctx = await running([tag('A', 'hr:0')]);
    await ctx.source.start(ctx.emit);
    await waitFor(() => ctx.received.length >= 1);
    await ctx.source.stop();
    const n = ctx.received.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(ctx.received.length).toBe(n);
  });
});
