import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.validation';
import { AcquisitionSource, EmitFn, SourceHealth } from '../../ingestion/acquisition-source';
import { IngestionService } from '../../ingestion/ingestion.service';
import { generateSample, SignalSpec, simulatorSignals } from './signal';

/**
 * "Teste de Carga Simulado" (Fase 1).
 *
 * Fonte de aquisição que gera amostras senoidais (simulando temperatura,
 * pressão, vazão e nível) a cada SIM_INTERVAL_MS, para SIM_TAGS tags. Buffer
 * e gravação ficam com o núcleo de ingestão, exatamente como para
 * MQTT/Modbus/OPC UA.
 */
@Injectable()
export class SimulatorSource implements AcquisitionSource, OnModuleInit {
  readonly name = 'sim';
  private readonly logger = new Logger(SimulatorSource.name);
  private timer?: NodeJS.Timeout;
  private signals: SignalSpec[] = [];

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly ingestion: IngestionService,
  ) {}

  onModuleInit() {
    if (!this.config.get('SIM_ENABLED', { infer: true })) {
      this.logger.log('Simulador desabilitado (SIM_ENABLED=false).');
      return;
    }
    this.ingestion.register(this);
  }

  start(emit: EmitFn) {
    const interval = this.config.get('SIM_INTERVAL_MS', { infer: true });
    const signals = (this.signals = simulatorSignals(this.config.get('SIM_TAGS', { infer: true })));
    this.timer = setInterval(() => {
      const now = new Date();
      emit(signals.map((spec) => generateSample(spec, now)));
    }, interval);
    this.logger.log(`Simulador: ${signals.length} tags a cada ${interval}ms.`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  status(): SourceHealth {
    const interval = this.config.get('SIM_INTERVAL_MS', { infer: true });
    return { tags: this.signals.length, detail: `senoides a cada ${interval} ms` };
  }
}
