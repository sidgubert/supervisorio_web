import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'fs';
import { AddressInfo, createServer } from 'net';
import {
  DataType,
  MessageSecurityMode,
  SecurityPolicy,
  StatusCode,
  StatusCodes,
  Variant,
  VariantArrayType,
} from 'node-opcua-client';
import { OPCUACertificateManager } from 'node-opcua-certificate-manager';
import { OPCUAServer } from 'node-opcua-server';
import { tmpdir } from 'os';
import { join } from 'path';
import { Subject } from 'rxjs';
import { Env } from '../../config/env.validation';
import { IngestionService } from '../../ingestion/ingestion.service';
import { QUALITY_BAD, QUALITY_UNCERTAIN, SampleInput } from '../../ingestion/sample';
import { Tag } from '../../tags/tag.entity';
import { TagChange, TagsService } from '../../tags/tags.service';
import { OpcUaSource } from './opcua.source';

/**
 * Testa a fonte contra um servidor OPC UA de verdade (node-opcua-server) numa
 * porta livre: tipos de dado, StatusCode, NodeId inexistente, cadastro
 * dinâmico, servidor fora do ar na subida e reinício do servidor.
 */
jest.setTimeout(30_000);

const pki = mkdtempSync(join(tmpdir(), 'talos-opcua-test-'));
const serverCertificateManager = new OPCUACertificateManager({
  rootFolder: join(pki, 'server'),
  automaticallyAcceptUnknownCertificate: true,
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Servidor com variáveis de vários tipos em ns=1;s=<nome>. Sem segurança, ou só com ela. */
async function startServer(port: number, secure = false) {
  const server = new OPCUAServer({
    port,
    resourcePath: '/UA/teste',
    allowAnonymous: true,
    securityModes: secure
      ? [MessageSecurityMode.Sign, MessageSecurityMode.SignAndEncrypt]
      : [MessageSecurityMode.None],
    securityPolicies: [secure ? SecurityPolicy.Basic256Sha256 : SecurityPolicy.None],
    serverCertificateManager,
  });
  await server.initialize();
  const addressSpace = server.engine.addressSpace!;
  const ns = addressSpace.getOwnNamespace();
  const device = ns.addObject({
    organizedBy: addressSpace.rootFolder.objects,
    browseName: 'Device',
  });
  /** O que o teste usa de uma variável do servidor. */
  type Settable = { setValueFromSource(v: Variant, status?: StatusCode, time?: Date): void };
  const vars = new Map<string, { variable: Settable; dataType: DataType }>();
  const initial: [string, DataType, unknown][] = [
    ['Temperature', DataType.Double, 21.5],
    ['Pressure', DataType.Float, 4.25],
    ['Running', DataType.Boolean, true],
    ['Counter', DataType.UInt32, 7],
    ['Big', DataType.Int64, [1, 2]],
    ['Label', DataType.String, 'texto'],
  ];
  for (const [name, dataType, value] of initial) {
    const variable = ns.addVariable({
      componentOf: device,
      browseName: name,
      nodeId: `s=${name}`,
      dataType: DataType[dataType],
    });
    variable.setValueFromSource(
      new Variant({ dataType, arrayType: VariantArrayType.Scalar, value }),
      StatusCodes.Good,
    );
    vars.set(name, { variable, dataType });
  }
  await server.start();

  return {
    set(name: string, value: unknown, status: StatusCode = StatusCodes.Good, time?: Date) {
      const v = vars.get(name)!;
      v.variable.setValueFromSource(
        new Variant({ dataType: v.dataType, arrayType: VariantArrayType.Scalar, value }),
        status,
        time,
      );
    },
    stop: () => server.shutdown(0),
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('condição não atingida a tempo');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const tag = (name: string, address: string, extra: Partial<Tag> = {}) =>
  ({ tag: name, source: 'opcua', address, enabled: true, ...extra }) as Tag;

type Security = Pick<
  Env,
  'OPCUA_SECURITY_MODE' | 'OPCUA_SECURITY_POLICY' | 'OPCUA_TRUST_UNKNOWN_CERTS' | 'OPCUA_PKI_DIR'
>;

function setup(port: number, initialTags: Tag[], enabled = true, security: Partial<Security> = {}) {
  let tags = initialTags;
  const changes = new Subject<TagChange>();
  const tagsService = {
    registerAddressValidator: jest.fn(),
    findEnabledBySource: jest.fn(() => Promise.resolve(tags.filter((t) => t.enabled))),
    changes$: changes,
  };
  const ingestion = { register: jest.fn() };
  const values = {
    OPCUA_ENABLED: enabled,
    OPCUA_ENDPOINT: `opc.tcp://localhost:${port}/UA/teste`,
    OPCUA_SAMPLING_MS: 50,
    // A fonte cria o próprio gerenciador de certificados nesta pasta.
    OPCUA_PKI_DIR: join(pki, 'client'),
    OPCUA_SECURITY_MODE: 'none',
    OPCUA_SECURITY_POLICY: 'Basic256Sha256',
    OPCUA_TRUST_UNKNOWN_CERTS: true,
    ...security,
  };
  const config = {
    get: (k: keyof typeof values) => values[k],
  } as unknown as ConfigService<Env, true>;
  const source = new OpcUaSource(
    config,
    ingestion as unknown as IngestionService,
    tagsService as unknown as TagsService,
  );
  source.clientOptions = {
    connectionStrategy: { maxRetry: -1, initialDelay: 100, maxDelay: 300 },
  };
  source.retryDelayMs = 200;
  const received: SampleInput[] = [];
  const emit = (s: SampleInput[]) => received.push(...s);
  const setTags = (next: Tag[], change: TagChange) => {
    tags = next;
    changes.next(change);
  };
  return { source, tagsService, ingestion, received, emit, setTags };
}

const of = (received: SampleInput[], name: string) => received.filter((s) => s.tag === name);

describe('OpcUaSource', () => {
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let source: OpcUaSource | undefined;

  beforeAll(() => {
    Logger.overrideLogger(false);
    // O node-opcua imprime diagnósticos no console (ex: o servidor mínimo de
    // teste não tem todos os nós de capacidade que o cliente consulta).
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await source?.stop();
    await server?.stop();
    source = server = undefined;
  });

  afterAll(async () => {
    // O gerenciador de certificados mantém observadores de arquivo abertos
    // (o do cliente é descartado pela própria fonte, no stop).
    await serverCertificateManager.dispose();
    rmSync(pki, { recursive: true, force: true });
  });

  async function running(tags: Tag[]) {
    const port = await freePort();
    server = await startServer(port);
    const ctx = setup(port, tags);
    source = ctx.source;
    await source.start(ctx.emit);
    return { ...ctx, port };
  }

  it('onModuleInit: registra o validador sempre e a fonte só se habilitada', () => {
    const on = setup(1, []);
    on.source.onModuleInit();
    expect(on.tagsService.registerAddressValidator).toHaveBeenCalledWith(
      'opcua',
      expect.any(Function),
    );
    expect(on.ingestion.register).toHaveBeenCalledWith(on.source);

    const off = setup(1, [], false);
    off.source.onModuleInit();
    expect(off.ingestion.register).not.toHaveBeenCalled();
  });

  it('recebe os valores iniciais e as mudanças, convertendo os tipos', async () => {
    const ctx = await running([
      tag('TT-1', 'ns=1;s=Temperature'),
      tag('PT-1', 'ns=1;s=Pressure'),
      tag('XV-1', 'ns=1;s=Running'),
      tag('FQ-1', 'ns=1;s=Counter'),
      tag('BIG', 'ns=1;s=Big'),
    ]);
    await waitFor(() => ctx.received.length >= 5);
    const initial = Object.fromEntries(ctx.received.map((s) => [s.tag, s.value]));
    expect(initial).toEqual({ 'TT-1': 21.5, 'PT-1': 4.25, 'XV-1': 1, 'FQ-1': 7, BIG: 4294967298 });
    expect(source!.status()).toMatchObject({ connected: true, tags: 5 });

    const t = new Date(Date.now() - 2000);
    server!.set('Temperature', 22.75, StatusCodes.Good, t);
    await waitFor(() => of(ctx.received, 'TT-1').length >= 2);
    expect(of(ctx.received, 'TT-1').at(-1)).toEqual({
      tag: 'TT-1',
      value: 22.75,
      quality: 192,
      time: t, // sourceTimestamp do servidor
    });
  });

  it('StatusCode: Uncertain mantém o valor; Bad grava o último valor bom uma vez', async () => {
    const ctx = await running([tag('TT-1', 'ns=1;s=Temperature')]);
    await waitFor(() => ctx.received.length >= 1);

    server!.set('Temperature', 23, StatusCodes.UncertainLastUsableValue);
    await waitFor(() => ctx.received.length >= 2);
    expect(ctx.received[1]).toMatchObject({ value: 23, quality: QUALITY_UNCERTAIN });

    server!.set('Temperature', 0, StatusCodes.BadSensorFailure);
    await waitFor(() => ctx.received.length >= 3);
    server!.set('Temperature', 1, StatusCodes.BadSensorFailure);
    await new Promise((r) => setTimeout(r, 300));
    expect(ctx.received.slice(2)).toEqual([
      expect.objectContaining({ tag: 'TT-1', value: 23, quality: QUALITY_BAD }),
    ]);
    expect(source!.status().detail).toMatch(/1 tag\(s\) sem leitura/);

    server!.set('Temperature', 24);
    await waitFor(() => ctx.received.at(-1)?.value === 24);
    expect(source!.status().detail).not.toMatch(/sem leitura/);
  });

  it('ignora valores não numéricos e NodeIds que o servidor não conhece', async () => {
    const ctx = await running([
      tag('TT-1', 'ns=1;s=Temperature'),
      tag('TXT', 'ns=1;s=Label'),
      tag('NADA', 'ns=1;s=NaoExiste'),
    ]);
    await waitFor(() => /recusado/.test(source!.status().detail ?? ''));
    await waitFor(() => ctx.received.length >= 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(ctx.received.map((s) => s.tag)).toEqual(['TT-1']);
    expect(source!.status().detail).toMatch(/1 NodeId\(s\) recusado\(s\)/);
  });

  it('acompanha o cadastro: monitora tags novas e para de monitorar as removidas', async () => {
    const tt = tag('TT-1', 'ns=1;s=Temperature');
    const pt = tag('PT-1', 'ns=1;s=Pressure');
    const ctx = await running([tt]);
    await waitFor(() => ctx.received.length >= 1);

    ctx.setTags([tt, pt], { type: 'created', tag: pt });
    await waitFor(() => of(ctx.received, 'PT-1').length >= 1);

    ctx.setTags([pt], { type: 'deleted', tag: tt });
    await waitFor(() => source!.status().tags === 1);
    await new Promise((r) => setTimeout(r, 200));
    const before = of(ctx.received, 'TT-1').length;
    server!.set('Temperature', 99);
    server!.set('Pressure', 5.5);
    await waitFor(() => of(ctx.received, 'PT-1').at(-1)?.value === 5.5);
    expect(of(ctx.received, 'TT-1').length).toBe(before);
  });

  it('SignAndEncrypt: conecta com certificados e recebe os valores', async () => {
    const port = await freePort();
    server = await startServer(port, true);
    const ctx = setup(port, [tag('TT-1', 'ns=1;s=Temperature')], true, {
      OPCUA_SECURITY_MODE: 'sign_and_encrypt',
      OPCUA_PKI_DIR: join(pki, 'client-secure'),
    });
    source = ctx.source;
    await source.start(ctx.emit);
    await waitFor(() => ctx.received.length >= 1, 20_000);
    expect(ctx.received[0]).toMatchObject({ tag: 'TT-1', value: 21.5 });
    expect(source.status().detail).toMatch(/segurança SignAndEncrypt\/Basic256Sha256/);
  });

  it('sem segurança, não conecta num servidor que a exige', async () => {
    const port = await freePort();
    server = await startServer(port, true);
    const ctx = setup(port, [tag('TT-1', 'ns=1;s=Temperature')]);
    source = ctx.source;
    await source.start(ctx.emit);
    await new Promise((r) => setTimeout(r, 1500));
    expect(source.status().connected).toBe(false);
    expect(ctx.received).toHaveLength(0);
  });

  it('OPCUA_TRUST_UNKNOWN_CERTS=false: recusa o servidor até o certificado ser confiado', async () => {
    const port = await freePort();
    server = await startServer(port, true);
    const clientPki = join(pki, 'client-strict');
    const ctx = setup(port, [tag('TT-1', 'ns=1;s=Temperature')], true, {
      OPCUA_SECURITY_MODE: 'sign',
      OPCUA_TRUST_UNKNOWN_CERTS: false,
      OPCUA_PKI_DIR: clientPki,
    });
    source = ctx.source;
    await source.start(ctx.emit);

    // O certificado desconhecido vai para rejected/, e nada é recebido.
    const rejected = join(clientPki, 'rejected');
    const listRejected = () => {
      try {
        return readdirSync(rejected).filter((f) => f.endsWith('.pem') || f.endsWith('.der'));
      } catch {
        return [];
      }
    };
    await waitFor(() => listRejected().length > 0, 20_000);
    expect(source.status().connected).toBe(false);
    expect(ctx.received).toHaveLength(0);

    // O operador confia no certificado (move para trusted/certs): conecta sozinho.
    const trusted = join(clientPki, 'trusted', 'certs');
    mkdirSync(trusted, { recursive: true });
    for (const f of listRejected()) renameSync(join(rejected, f), join(trusted, f));
    await waitFor(() => ctx.received.length >= 1, 25_000);
    expect(source.status().connected).toBe(true);
  });

  it('servidor fora na subida: não trava, e conecta quando ele aparece', async () => {
    const port = await freePort();
    const ctx = setup(port, [tag('TT-1', 'ns=1;s=Temperature')]);
    source = ctx.source;
    const t0 = Date.now();
    await source.start(ctx.emit);
    expect(Date.now() - t0).toBeLessThan(1000);
    await new Promise((r) => setTimeout(r, 500));
    expect(source.status().connected).toBe(false);

    server = await startServer(port);
    await waitFor(() => ctx.received.length >= 1);
    expect(ctx.received[0]).toMatchObject({ tag: 'TT-1', value: 21.5 });
  });

  it('stop não trava enquanto o servidor está fora', async () => {
    const ctx = setup(await freePort(), [tag('TT-1', 'ns=1;s=Temperature')]);
    await ctx.source.start(ctx.emit);
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    await ctx.source.stop();
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('servidor reinicia: uma amostra Bad por tag, depois reconecta e volta a receber', async () => {
    const ctx = await running([
      tag('TT-1', 'ns=1;s=Temperature'),
      tag('PT-1', 'ns=1;s=Pressure'),
      tag('TXT', 'ns=1;s=Label'), // não numérica: monitorada, mas sem amostras
      tag('NADA', 'ns=1;s=NaoExiste'), // recusada pelo servidor
    ]);
    await waitFor(() => ctx.received.length >= 2);
    await waitFor(() => /recusado/.test(source!.status().detail ?? ''));

    await server!.stop();
    await waitFor(() => ctx.received.filter((s) => s.quality === QUALITY_BAD).length === 2);
    expect(source!.status().connected).toBe(false);

    server = await startServer(ctx.port);
    server.set('Temperature', 30);
    await waitFor(() => of(ctx.received, 'TT-1').at(-1)?.value === 30, 20_000);
    expect(source!.status().connected).toBe(true);
    expect(ctx.received.filter((s) => s.quality === QUALITY_BAD)).toHaveLength(2);
    // Depois de voltar, nenhuma tag fica presa como "sem leitura".
    await waitFor(() => !/sem leitura/.test(source!.status().detail ?? ''));
  });
});
