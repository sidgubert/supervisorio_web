import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env.validation';
import { MeasurementsService } from '../measurements/measurements.service';
import { DEFAULT_SIGNALS, generateSample, Sample } from './signal';

/**
 * "Teste de Carga Simulado" (Fase 1).
 *
 * Gera continuamente amostras senoidais (simulando temperatura, pressão,
 * vazão e nível) e as persiste em lote no banco de séries temporais,
 * validando todo o caminho de escrita: NestJS -> TypeORM -> TimescaleDB.
 */
@Injectable()
export class SimulatorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SimulatorService.name);
  private buffer: Sample[] = [];
  private genTimer?: NodeJS.Timeout;
  private flushTimer?: NodeJS.Timeout;

  /** Gravação em andamento; impede dois flush simultâneos. */
  private inFlight?: Promise<void>;
  /** Teto do buffer: se o banco ficar fora, descarta as amostras mais antigas. */
  private maxBuffer = 100_000;
  /** Máximo de amostras gravadas por flush, para manter cada ciclo curto. */
  private maxPerFlush = 10_000;
  /** Amostras descartadas desde o último aviso no log. */
  private dropped = 0;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly measurements: MeasurementsService,
  ) {}

  onModuleInit() {
    if (!this.config.get('SIM_ENABLED', { infer: true })) {
      this.logger.log('Simulador desabilitado (SIM_ENABLED=false).');
      return;
    }

    const interval = this.config.get('SIM_INTERVAL_MS', { infer: true });
    const flush = this.config.get('SIM_BATCH_FLUSH_MS', { infer: true });
    this.maxBuffer = this.config.get('SIM_BUFFER_MAX', { infer: true });

    // 1) Gera amostras em memória a cada `interval` ms.
    this.genTimer = setInterval(() => this.generate(), interval);

    // 2) Descarrega o buffer no banco a cada `flush` ms (escrita em lote).
    this.flushTimer = setInterval(() => this.flush(), flush);

    this.logger.log(
      `Simulador ativo: ${DEFAULT_SIGNALS.length} tags, gerando a cada ${interval}ms, gravando a cada ${flush}ms.`,
    );
  }

  /** Para os timers e grava o que restou no buffer antes de encerrar. */
  async onModuleDestroy() {
    if (this.genTimer) clearInterval(this.genTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.inFlight;
    while (this.buffer.length > 0) {
      const before = this.buffer.length;
      await this.flush();
      if (this.buffer.length >= before) break; // banco indisponível: desiste
    }
  }

  private generate() {
    const now = new Date();
    for (const spec of DEFAULT_SIGNALS) {
      this.buffer.push(generateSample(spec, now));
    }
    this.enforceCap();
  }

  private flush(): Promise<void> {
    // Se a gravação anterior ainda não terminou, pula este ciclo.
    if (this.inFlight || this.buffer.length === 0) return this.inFlight ?? Promise.resolve();
    this.inFlight = this.writeNext().finally(() => (this.inFlight = undefined));
    return this.inFlight;
  }

  private async writeNext() {
    if (this.dropped > 0) {
      this.logger.warn(`Buffer cheio: ${this.dropped} amostras antigas descartadas.`);
      this.dropped = 0;
    }

    const batch = this.buffer.splice(0, this.maxPerFlush);
    try {
      const n = await this.measurements.insertBatch(batch);
      this.logger.debug(`Gravadas ${n} amostras (${this.buffer.length} pendentes).`);
    } catch (err) {
      // Em caso de falha, devolve as amostras ao início do buffer (mantendo
      // a ordem) para nova tentativa no próximo ciclo.
      this.buffer = batch.concat(this.buffer);
      this.enforceCap();
      this.logger.error(
        `Falha ao gravar lote (${this.buffer.length} pendentes): ${(err as Error).message}`,
      );
    }
  }

  /** Mantém o buffer dentro do teto, descartando as amostras mais antigas. */
  private enforceCap() {
    const excess = this.buffer.length - this.maxBuffer;
    if (excess > 0) {
      this.buffer.splice(0, excess);
      this.dropped += excess;
    }
  }
}
