import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OPCUACertificateManager } from 'node-opcua-certificate-manager';
import type {
  ClientMonitoredItem,
  ClientSession,
  ClientSubscription,
  DataValue,
  OPCUAClient,
  OPCUAClientOptions,
} from 'node-opcua-client';
import { join, resolve } from 'path';
import { Subscription } from 'rxjs';
import { errorMessage } from '../../common/error-message';
import { RateLimitedLogger } from '../../common/rate-limited-logger';
import { Env } from '../../config/env.validation';
import { AcquisitionSource, EmitFn, SourceHealth } from '../../ingestion/acquisition-source';
import { IngestionService } from '../../ingestion/ingestion.service';
import { QUALITY_BAD, SampleInput } from '../../ingestion/sample';
import { TagChange, TagsService } from '../../tags/tags.service';
import {
  dataTypeName,
  qualityFromStatusCode,
  validateNodeId,
  variantToNumber,
} from './opcua-mapping';

type OpcUa = typeof import('node-opcua-client');

/** OPCUA_SECURITY_MODE -> nome do MessageSecurityMode no node-opcua. */
const SECURITY_MODES = { none: 'None', sign: 'Sign', sign_and_encrypt: 'SignAndEncrypt' } as const;

/**
 * Fonte OPC UA: monitora (subscription) o atributo Value de cada tag com
 * `source = opcua`, cujo `address` é o NodeId (ex: ns=3;s=SlowUInt1), no
 * servidor OPCUA_ENDPOINT.
 *
 * - O servidor avisa a cada mudança (amostragem OPCUA_SAMPLING_MS): não há
 *   polling, e o horário da amostra é o sourceTimestamp do servidor.
 * - O StatusCode vira a qualidade (Good 192, Uncertain 64, Bad 0); com Bad,
 *   grava o último valor bom com qualidade Bad, como a fonte Modbus.
 * - Não trava a subida: conecta e reconecta em segundo plano (o node-opcua
 *   restaura sessão e assinaturas sozinho). Conexão perdida marca as tags
 *   como Bad uma vez.
 * - Acompanha o cadastro: cria e remove itens monitorados sem reiniciar.
 * - O node-opcua (~1 s para carregar) só é importado com a fonte habilitada.
 *
 * Segurança (OPCUA_SECURITY_MODE): `none` (padrão, laboratório), `sign`
 * (mensagens assinadas: ninguém altera no caminho) ou `sign_and_encrypt`
 * (também cifradas: ninguém lê no caminho), com os algoritmos de
 * OPCUA_SECURITY_POLICY. Com segurança, cliente e servidor trocam
 * certificados: o servidor precisa confiar no do cliente (OPCUA_PKI_DIR/own/certs),
 * e o cliente, no do servidor. Com OPCUA_TRUST_UNKNOWN_CERTS=false, só aceita
 * servidor cujo certificado esteja em OPCUA_PKI_DIR/trusted/certs; um
 * desconhecido vai para OPCUA_PKI_DIR/rejected e a conexão é recusada. O
 * usuário é sempre anônimo.
 */
@Injectable()
export class OpcUaSource implements AcquisitionSource, OnModuleInit {
  readonly name = 'opcua';
  private readonly logger = new Logger(OpcUaSource.name);
  private readonly rateLimited = new RateLimitedLogger(this.logger);
  private emit?: EmitFn;
  private stopped = true;
  private changes?: Subscription;

  /** tag -> NodeId, segundo o cadastro. */
  private desired = new Map<string, string>();
  /** Itens monitorados ativos. */
  private readonly items = new Map<string, { nodeId: string; item: ClientMonitoredItem }>();
  /** Tags cujo NodeId o servidor recusou (ex: BadNodeIdUnknown), por NodeId. */
  private readonly rejected = new Map<string, string>();
  private readonly lastGood = new Map<string, number>();
  private readonly bad = new Set<string>();

  private lib?: OpcUa;
  private certificates?: OPCUACertificateManager;
  private client?: OPCUAClient;
  private session?: ClientSession;
  private subscription?: ClientSubscription;
  private connected = false;
  private running?: Promise<void>;
  /** Sincronizações dos itens monitorados, em série. */
  private syncing: Promise<void> = Promise.resolve();

  /** Opções extras do cliente (os testes usam para acelerar a reconexão). */
  clientOptions: Partial<OPCUAClientOptions> = {};
  /** Espera entre tentativas quando a conexão falha de vez (ex: certificado). */
  retryDelayMs = 10_000;
  /** Interrompe a espera entre tentativas (no stop). */
  private wake?: () => void;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly ingestion: IngestionService,
    private readonly tags: TagsService,
  ) {}

  onModuleInit() {
    this.tags.registerAddressValidator(this.name, validateNodeId);
    if (!this.config.get('OPCUA_ENABLED', { infer: true })) {
      this.logger.log('Fonte OPC UA desabilitada (OPCUA_ENABLED=false).');
      return;
    }
    this.ingestion.register(this);
  }

  async start(emit: EmitFn) {
    this.emit = emit;
    this.stopped = false;
    this.desired = await this.loadTags();
    this.changes = this.tags.changes$.subscribe((change) => {
      if (this.concerns(change)) this.scheduleSync(true);
    });
    this.logger.log(
      `Conectando a ${this.endpoint()} (segurança ${this.securityLabel()}, ` +
        `amostragem ${this.samplingMs()} ms)...`,
    );
    if (this.secure() && this.config.get('OPCUA_TRUST_UNKNOWN_CERTS', { infer: true })) {
      this.logger.warn(
        'OPCUA_TRUST_UNKNOWN_CERTS=true: o certificado do servidor é aceito sem verificação ' +
          '(a conexão é cifrada, mas não se confirma com quem). Use false fora do laboratório.',
      );
    }
    this.running = this.runUntilStopped();
  }

  /**
   * Tenta conectar até conseguir ou a fonte parar. Quedas de conexão o
   * próprio node-opcua resolve; aqui ficam as falhas que ele não repete, como
   * certificado do servidor não confiável: a fonte espera retryDelayMs e tenta
   * de novo, então basta confiar no certificado, sem reiniciar a API.
   */
  private async runUntilStopped() {
    while (!this.stopped) {
      try {
        await this.run();
        return;
      } catch (err) {
        if (this.stopped) return;
        this.connected = false;
        const delay = this.retryDelayMs;
        this.rateLimited.error(
          'run',
          `Falha ao conectar a ${this.endpoint()}: ${errorMessage(err)}${this.hint(err)} ` +
            `Nova tentativa a cada ${delay / 1000} s.`,
        );
        await this.disposeClient();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wake = undefined;
      }
    }
  }

  /** Dica para os erros de certificado, os mais comuns ao ligar a segurança. */
  private hint(err: unknown): string {
    const pki = resolve(this.config.get('OPCUA_PKI_DIR', { infer: true }));
    if (/BadCertificateUntrusted/.test(errorMessage(err))) {
      return (
        `. O certificado do servidor não é confiável e foi salvo em ${join(pki, 'rejected')};` +
        ` para confiar nele, mova-o para ${join(pki, 'trusted', 'certs')}.`
      );
    }
    return '.';
  }

  private async disposeClient() {
    await withTimeout(this.client?.disconnect(), 3000).catch(() => undefined);
    await this.certificates?.dispose().catch(() => undefined);
    this.certificates = undefined;
    this.subscription = this.session = this.client = undefined;
  }

  async stop() {
    this.stopped = true;
    this.wake?.();
    this.changes?.unsubscribe();
    await this.syncing;
    // Fechar a sessão avisa o servidor; com a conexão caída, não espera muito.
    await withTimeout(this.session?.close(), 3000).catch(() => undefined);
    await withTimeout(this.client?.disconnect(), 3000).catch(() => undefined);
    await this.running;
    await this.disposeClient();
    this.items.clear();
    this.connected = false;
    this.emit = undefined;
  }

  status(): SourceHealth {
    const notes: string[] = [];
    if (this.rejected.size > 0)
      notes.push(`${this.rejected.size} NodeId(s) recusado(s) pelo servidor`);
    if (this.bad.size > 0) notes.push(`${this.bad.size} tag(s) sem leitura`);
    return {
      connected: this.connected,
      tags: this.desired.size,
      detail: [this.endpoint(), `segurança ${this.securityLabel()}`, ...notes].join(', '),
    };
  }

  private endpoint() {
    return this.config.get('OPCUA_ENDPOINT', { infer: true });
  }

  private samplingMs() {
    return this.config.get('OPCUA_SAMPLING_MS', { infer: true });
  }

  private secure() {
    return this.config.get('OPCUA_SECURITY_MODE', { infer: true }) !== 'none';
  }

  /** Ex: "None" ou "SignAndEncrypt/Basic256Sha256". */
  private securityLabel() {
    const mode = SECURITY_MODES[this.config.get('OPCUA_SECURITY_MODE', { infer: true })];
    if (!this.secure()) return mode;
    return `${mode}/${this.config.get('OPCUA_SECURITY_POLICY', { infer: true })}`;
  }

  /** Conecta (tentando indefinidamente), abre sessão e assinatura. */
  private async run() {
    const lib = (this.lib ??= await import('node-opcua-client'));
    if (this.stopped) return;
    const endpoint = this.endpoint();
    // Certificados numa pasta só desta aplicação (e não na pasta compartilhada
    // por todos os programas node-opcua do usuário): own/ é o do cliente,
    // trusted/ e rejected/ os dos servidores.
    const { OPCUACertificateManager } = await import('node-opcua-certificate-manager');
    // No Windows, o fs.watch dá erro (EPERM) quando um certificado observado
    // é movido ou apagado, e o node-opcua-pki não trata esse erro: a API cairia
    // justamente ao confiar num certificado (mover de rejected/ para trusted/).
    // Verificando as pastas por polling (a cada 5 s), o problema não existe.
    process.env.OPCUA_PKI_USE_POLLING ??= 'true';
    this.certificates = new OPCUACertificateManager({
      rootFolder: resolve(this.config.get('OPCUA_PKI_DIR', { infer: true })),
      automaticallyAcceptUnknownCertificate: this.config.get('OPCUA_TRUST_UNKNOWN_CERTS', {
        infer: true,
      }),
    });
    const mode = this.config.get('OPCUA_SECURITY_MODE', { infer: true });
    const policy = this.config.get('OPCUA_SECURITY_POLICY', { infer: true });
    const client = lib.OPCUAClient.create({
      clientCertificateManager: this.certificates,
      applicationName: 'talos',
      endpointMustExist: false,
      securityMode: lib.MessageSecurityMode[SECURITY_MODES[mode]],
      securityPolicy: this.secure() ? lib.SecurityPolicy[policy] : lib.SecurityPolicy.None,
      keepSessionAlive: true,
      connectionStrategy: { maxRetry: -1, initialDelay: 1000, maxDelay: 10_000 },
      ...this.clientOptions,
    });
    this.client = client;

    client.on('backoff', (count, delay) => {
      this.rateLimited.warn(
        'conn',
        `Sem conexão com ${endpoint}; nova tentativa em ${delay} ms (tentativa ${count}).`,
      );
    });
    client.on('connection_lost', () => {
      this.connected = false;
      this.logger.warn(`Conexão com ${endpoint} perdida; reconectando...`);
      const out: SampleInput[] = [];
      // Só as tags de fato monitoradas (não as recusadas pelo servidor).
      this.markBad([...this.items.keys()], out);
      this.flush(out);
    });
    client.on('connection_reestablished', () => {
      this.connected = true;
      this.rateLimited.reset('conn');
      this.logger.log(`Conexão com ${endpoint} restabelecida.`);
      // NodeIds recusados antes podem existir agora (servidor reconfigurado).
      this.rejected.clear();
      this.scheduleSync(false);
    });

    await client.connect(endpoint);
    if (this.stopped) return;
    this.session = await client.createSession();
    this.subscription = await this.session.createSubscription2({
      requestedPublishingInterval: this.samplingMs(),
      requestedLifetimeCount: 100,
      requestedMaxKeepAliveCount: 10,
      maxNotificationsPerPublish: 1000,
      publishingEnabled: true,
      priority: 10,
    });
    this.connected = true;
    this.rateLimited.reset('conn');
    this.rateLimited.reset('run');
    this.logger.log(`Conectado a ${endpoint} (segurança ${this.securityLabel()}).`);
    this.scheduleSync(false);
  }

  private scheduleSync(reloadTags: boolean) {
    this.syncing = this.syncing
      .then(async () => {
        if (reloadTags) this.desired = await this.loadTags();
        await this.syncItems();
      })
      .catch((err) =>
        this.logger.error(`Falha ao sincronizar as tags OPC UA: ${errorMessage(err)}`),
      );
  }

  /** Ajusta os itens monitorados ao cadastro (cria os que faltam, remove os que saíram). */
  private async syncItems() {
    const subscription = this.subscription;
    const lib = this.lib;
    if (!subscription || !lib || this.stopped) return;

    for (const [tag, current] of [...this.items]) {
      if (this.desired.get(tag) === current.nodeId) continue;
      this.items.delete(tag);
      await current.item.terminate().catch(() => undefined);
    }
    for (const [tag, nodeId] of [...this.rejected]) {
      if (this.desired.get(tag) !== nodeId) this.rejected.delete(tag);
    }
    for (const tag of [...this.lastGood.keys()])
      if (!this.desired.has(tag)) this.lastGood.delete(tag);
    for (const tag of [...this.bad]) if (!this.desired.has(tag)) this.bad.delete(tag);

    for (const [tag, nodeId] of this.desired) {
      if (this.items.has(tag) || this.rejected.get(tag) === nodeId || this.stopped) continue;
      try {
        const item = await subscription.monitor(
          { nodeId, attributeId: lib.AttributeIds.Value },
          { samplingInterval: this.samplingMs(), discardOldest: true, queueSize: 10 },
          lib.TimestampsToReturn.Both,
          lib.MonitoringMode.Reporting,
        );
        if (item.statusCode.isNotGood()) throw new Error(item.statusCode.name);
        item.on('changed', (dataValue: DataValue) => this.onChange(tag, item, dataValue));
        this.items.set(tag, { nodeId, item });
      } catch (err) {
        this.rejected.set(tag, nodeId);
        this.logger.warn(`Tag "${tag}": o servidor recusou ${nodeId} (${errorMessage(err)}).`);
      }
    }
  }

  private onChange(tag: string, item: ClientMonitoredItem, dv: DataValue) {
    // Ignora notificações de um item que já saiu do cadastro.
    if (this.items.get(tag)?.item !== item) return;
    const time = dv.sourceTimestamp ?? dv.serverTimestamp ?? undefined;
    const quality = qualityFromStatusCode(dv.statusCode.value);
    const out: SampleInput[] = [];

    if (quality === QUALITY_BAD) {
      this.markBad([tag], out, time);
    } else {
      // O servidor está entregando a tag: ela não está mais "sem leitura",
      // mesmo que o valor não seja numérico (aí o problema é o tipo).
      this.bad.delete(tag);
      const value = variantToNumber(dv.value);
      if (value === undefined) {
        this.rateLimited.warn(
          `type:${tag}`,
          `Tag "${tag}": valor do tipo ${dataTypeName(dv.value.dataType)} não é numérico; ignorado.`,
        );
        return;
      }
      this.lastGood.set(tag, value);
      out.push({ tag, value, quality, time });
    }
    this.flush(out);
  }

  /** Primeira falha de cada tag: uma amostra Bad com o último valor bom (se houver). */
  private markBad(tags: string[], out: SampleInput[], time?: Date) {
    for (const tag of tags) {
      if (this.bad.has(tag)) continue;
      this.bad.add(tag);
      const last = this.lastGood.get(tag);
      if (last !== undefined) out.push({ tag, value: last, quality: QUALITY_BAD, time });
    }
  }

  private flush(out: SampleInput[]) {
    if (out.length > 0 && this.emit) this.emit(out);
  }

  private concerns(change: TagChange): boolean {
    return change.tag.source === this.name || change.previous?.source === this.name;
  }

  private async loadTags(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const t of await this.tags.findEnabledBySource(this.name)) {
      const error = validateNodeId(t.address);
      if (error) {
        this.logger.warn(`Tag "${t.tag}" ignorada: ${error}.`);
        continue;
      }
      map.set(t.tag, t.address!);
    }
    return map;
  }
}

/** Espera a promessa por no máximo `ms` (undefined = nada a esperar). */
function withTimeout<T>(promise: Promise<T> | undefined, ms: number): Promise<T | undefined> {
  if (!promise) return Promise.resolve(undefined);
  let timer: NodeJS.Timeout;
  const timeout = new Promise<undefined>(
    (resolve) => (timer = setTimeout(() => resolve(undefined), ms)),
  );
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
