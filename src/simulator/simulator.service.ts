import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

  constructor(
    private readonly config: ConfigService,
    private readonly measurements: MeasurementsService,
  ) {}

  onModuleInit() {
    const enabled = this.config.get('SIM_ENABLED', 'true') === 'true';
    if (!enabled) {
      this.logger.log('Simulador desabilitado (SIM_ENABLED=false).');
      return;
    }

    const interval = Number(this.config.get('SIM_INTERVAL_MS', 1000));
    const flush = Number(this.config.get('SIM_BATCH_FLUSH_MS', 2000));

    // 1) Gera amostras em memória a cada `interval` ms.
    this.genTimer = setInterval(() => this.generate(), interval);

    // 2) Descarrega o buffer no banco a cada `flush` ms (escrita em lote).
    this.flushTimer = setInterval(() => this.flush(), flush);

    this.logger.log(
      `Simulador ativo: ${DEFAULT_SIGNALS.length} tags, gerando a cada ${interval}ms, gravando a cada ${flush}ms.`,
    );
  }

  onModuleDestroy() {
    if (this.genTimer) clearInterval(this.genTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
  }

  private generate() {
    const now = new Date();
    for (const spec of DEFAULT_SIGNALS) {
      this.buffer.push(generateSample(spec, now));
    }
  }

  private async flush() {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      const n = await this.measurements.insertBatch(batch);
      this.logger.debug(`Gravadas ${n} amostras.`);
    } catch (err) {
      // Em caso de falha, devolve as amostras ao buffer para nova tentativa.
      this.buffer.unshift(...batch);
      this.logger.error(`Falha ao gravar lote: ${(err as Error).message}`);
    }
  }
}
