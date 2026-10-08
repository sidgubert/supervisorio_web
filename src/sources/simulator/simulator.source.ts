import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.validation';
import { AcquisitionSource, EmitFn } from '../../ingestion/acquisition-source';
import { IngestionService } from '../../ingestion/ingestion.service';
import { DEFAULT_SIGNALS, generateSample } from './signal';

/**
 * "Teste de Carga Simulado" (Fase 1).
 *
 * Fonte de aquisição que gera amostras senoidais (simulando temperatura,
 * pressão, vazão e nível) a cada SIM_INTERVAL_MS. Buffer e gravação ficam
 * com o núcleo de ingestão, exatamente como será para MQTT/Modbus/OPC UA.
 */
@Injectable()
export class SimulatorSource implements AcquisitionSource, OnModuleInit {
  readonly name = 'sim';
  private readonly logger = new Logger(SimulatorSource.name);
  private timer?: NodeJS.Timeout;

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
    this.timer = setInterval(() => {
      const now = new Date();
      emit(DEFAULT_SIGNALS.map((spec) => generateSample(spec, now)));
    }, interval);
    this.logger.log(`Simulador: ${DEFAULT_SIGNALS.length} tags a cada ${interval}ms.`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
