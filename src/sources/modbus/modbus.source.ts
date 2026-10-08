import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import ModbusRTU from 'modbus-serial';
import { Subscription } from 'rxjs';
import { errorMessage } from '../../common/error-message';
import { RateLimitedLogger } from '../../common/rate-limited-logger';
import { Env } from '../../config/env.validation';
import { AcquisitionSource, EmitFn, SourceHealth } from '../../ingestion/acquisition-source';
import { IngestionService } from '../../ingestion/ingestion.service';
import { QUALITY_BAD, SampleInput } from '../../ingestion/sample';
import { TagChange, TagsService } from '../../tags/tags.service';
import {
  decodeItem,
  parseModbusAddress,
  planReads,
  ReadBlock,
  ReadItem,
  validateModbusAddress,
} from './modbus-address';

/**
 * Fonte Modbus TCP: lê, a cada MODBUS_POLL_MS, as tags com `source = modbus`
 * (endereços em modbus-address.ts) no equipamento MODBUS_HOST:MODBUS_PORT.
 *
 * - Endereços contíguos viram um único request (planReads).
 * - Ciclos em série (setTimeout encadeado): um ciclo lento nunca se sobrepõe
 *   ao seguinte.
 * - Sem conexão, não trava a subida: tenta reconectar a cada ciclo.
 * - Quando uma tag deixa de ser lida (exceção do equipamento, timeout ou
 *   conexão perdida), emite UMA amostra com qualidade Bad e o último valor
 *   bom, marcando no histórico onde o dado deixou de valer; as leituras boas
 *   seguintes voltam ao normal.
 * - Acompanha o cadastro de tags sem reiniciar a API.
 */
@Injectable()
export class ModbusSource implements AcquisitionSource, OnModuleInit {
  readonly name = 'modbus';
  private readonly logger = new Logger(ModbusSource.name);
  private readonly rateLimited = new RateLimitedLogger(this.logger);
  private client?: ModbusRTU;
  private emit?: EmitFn;
  private plan: ReadBlock[] = [];
  private tagCount = 0;
  /**
   * Plano recalculado após uma alteração no cadastro. Só entra em vigor no
   * início do próximo ciclo: como os ciclos são em série, a troca é atômica e
   * um ciclo em andamento nunca mistura o plano antigo com o novo.
   */
  private pendingPlan?: Plan;
  private changes?: Subscription;
  private reloading: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private cycle?: Promise<void>;
  private stopped = true;
  /** Último valor bom de cada tag e tags atualmente sem leitura. */
  private readonly lastGood = new Map<string, number>();
  private readonly bad = new Set<string>();

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly ingestion: IngestionService,
    private readonly tags: TagsService,
  ) {}

  onModuleInit() {
    this.tags.registerAddressValidator(this.name, validateModbusAddress);
    if (!this.config.get('MODBUS_ENABLED', { infer: true })) {
      this.logger.log('Fonte Modbus desabilitada (MODBUS_ENABLED=false).');
      return;
    }
    this.ingestion.register(this);
  }

  async start(emit: EmitFn) {
    this.emit = emit;
    this.stopped = false;
    this.applyPlan(await this.loadPlan());
    this.changes = this.tags.changes$.subscribe((change) => {
      if (this.concerns(change)) this.scheduleReload();
    });
    this.logger.log(`Lendo ${this.target()} a cada ${this.pollMs()} ms.`);
    this.schedule(0);
  }

  async stop() {
    this.stopped = true;
    this.changes?.unsubscribe();
    if (this.timer) clearTimeout(this.timer);
    await this.cycle;
    await this.reloading;
    this.disconnect();
    this.emit = undefined;
  }

  status(): SourceHealth {
    const failing = this.bad.size > 0 ? `, ${this.bad.size} tag(s) sem leitura` : '';
    return {
      connected: this.client?.isOpen ?? false,
      tags: this.tagCount,
      detail: `${this.target()}${failing}`,
    };
  }

  private target() {
    const host = this.config.get('MODBUS_HOST', { infer: true });
    const port = this.config.get('MODBUS_PORT', { infer: true });
    return `${host}:${port}`;
  }

  private pollMs() {
    return this.config.get('MODBUS_POLL_MS', { infer: true });
  }

  private schedule(delayMs: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      const started = Date.now();
      this.cycle = this.poll()
        .catch((err) => this.logger.error(`Falha no ciclo de leitura: ${errorMessage(err)}`))
        .finally(() => this.schedule(Math.max(0, this.pollMs() - (Date.now() - started))));
    }, delayMs);
  }

  /** Um ciclo: garante a conexão, lê todos os blocos e emite o resultado. */
  private async poll() {
    if (this.pendingPlan) {
      this.applyPlan(this.pendingPlan);
      this.pendingPlan = undefined;
    }
    const plan = this.plan;
    if (plan.length === 0) return;
    const out: SampleInput[] = [];
    const tagsOf = (blocks: ReadBlock[]) => blocks.flatMap((b) => b.items.map((it) => it.tag));

    const client = await this.ensureConnected();
    if (!client) {
      this.markBad(tagsOf(plan), out);
      this.flush(out);
      return;
    }

    for (const [i, block] of plan.entries()) {
      try {
        const data = await this.read(client, block);
        for (const item of block.items) {
          const value = decodeItem(block, item, data);
          this.bad.delete(item.tag);
          this.lastGood.set(item.tag, value);
          out.push({ tag: item.tag, value });
        }
      } catch (err) {
        const where = `${block.area}:${block.start} (unit ${block.unit}, ${block.length})`;
        if ((err as { modbusCode?: number }).modbusCode !== undefined) {
          // O equipamento respondeu com exceção: só este bloco falhou.
          this.rateLimited.warn(
            `block:${where}`,
            `Exceção Modbus ao ler ${where}: ${errorMessage(err)}`,
          );
          this.markBad(
            block.items.map((it) => it.tag),
            out,
          );
          continue;
        }
        // Timeout ou conexão perdida: reconecta no próximo ciclo.
        this.rateLimited.error(
          'conn',
          `Falha de comunicação com ${this.target()}: ${errorMessage(err)}`,
        );
        this.disconnect();
        this.markBad(tagsOf(plan.slice(i)), out);
        break;
      }
    }
    this.flush(out);
  }

  private flush(out: SampleInput[]) {
    if (out.length > 0 && this.emit) this.emit(out);
  }

  private read(client: ModbusRTU, block: ReadBlock): Promise<number[] | boolean[]> {
    client.setID(block.unit);
    switch (block.area) {
      case 'hr':
        return client.readHoldingRegisters(block.start, block.length).then((r) => r.data);
      case 'ir':
        return client.readInputRegisters(block.start, block.length).then((r) => r.data);
      case 'coil':
        return client.readCoils(block.start, block.length).then((r) => r.data);
      case 'di':
        return client.readDiscreteInputs(block.start, block.length).then((r) => r.data);
    }
  }

  /**
   * Primeira falha de cada tag: uma amostra Bad com o último valor bom (se
   * houver). Tags que já estão sem leitura não geram nada.
   */
  private markBad(tags: string[], out: SampleInput[]) {
    for (const tag of tags) {
      if (this.bad.has(tag)) continue;
      this.bad.add(tag);
      const last = this.lastGood.get(tag);
      if (last !== undefined) out.push({ tag, value: last, quality: QUALITY_BAD });
    }
  }

  private async ensureConnected(): Promise<ModbusRTU | undefined> {
    if (this.client?.isOpen) return this.client;
    this.disconnect();
    const client = new ModbusRTU();
    // Antes de conectar: um 'error' sem listener derrubaria o processo. Os
    // erros chegam também como rejeição das promessas, tratadas abaixo.
    client.on('error', () => undefined);
    const timeout = this.config.get('MODBUS_TIMEOUT_MS', { infer: true });
    try {
      await client.connectTCP(this.config.get('MODBUS_HOST', { infer: true }), {
        port: this.config.get('MODBUS_PORT', { infer: true }),
        timeout,
      });
      client.setTimeout(timeout);
      this.client = client;
      this.rateLimited.reset('conn');
      this.logger.log(`Conectado a ${this.target()}.`);
      return client;
    } catch (err) {
      client.close(() => undefined);
      this.rateLimited.error('conn', `Sem conexão com ${this.target()}: ${errorMessage(err)}`);
      return undefined;
    }
  }

  private disconnect() {
    if (!this.client) return;
    const wasOpen = this.client.isOpen;
    this.client.close(() => undefined);
    this.client = undefined;
    if (wasOpen) this.logger.warn(`Conexão com ${this.target()} encerrada.`);
  }

  private concerns(change: TagChange): boolean {
    return change.tag.source === this.name || change.previous?.source === this.name;
  }

  private scheduleReload() {
    this.reloading = this.reloading
      .then(async () => {
        this.pendingPlan = await this.loadPlan();
      })
      .catch((err) =>
        this.logger.error(`Falha ao recarregar as tags Modbus: ${errorMessage(err)}`),
      );
  }

  /** Lê as tags Modbus do cadastro e monta o plano de leitura. */
  private async loadPlan(): Promise<Plan> {
    const items: ReadItem[] = [];
    for (const t of await this.tags.findEnabledBySource(this.name)) {
      const addr = parseModbusAddress(t.address);
      if ('error' in addr) {
        this.logger.warn(`Tag "${t.tag}" ignorada: ${addr.error}.`);
        continue;
      }
      items.push({ tag: t.tag, addr });
    }
    return { blocks: planReads(items), tags: new Set(items.map((it) => it.tag)) };
  }

  private applyPlan(plan: Plan) {
    this.plan = plan.blocks;
    this.tagCount = plan.tags.size;
    // Esquece o estado de tags que saíram do plano.
    for (const tag of [...this.lastGood.keys()]) if (!plan.tags.has(tag)) this.lastGood.delete(tag);
    for (const tag of [...this.bad]) if (!plan.tags.has(tag)) this.bad.delete(tag);
  }
}

interface Plan {
  blocks: ReadBlock[];
  tags: Set<string>;
}
