import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { AcquisitionSource } from './acquisition-source';
import { IngestionBuffer } from './ingestion-buffer';
import { QUALITY_GOOD, Sample, SampleInput } from './sample';

/**
 * Núcleo de ingestão: ponto único por onde todas as fontes entregam dados.
 *
 *   fonte.start(emit) -> ingest() [normaliza + valida] -> IngestionBuffer -> banco
 *
 * Ciclo de vida:
 * - as fontes se registram no onModuleInit delas (register);
 * - na subida (onApplicationBootstrap) inicia o buffer e as fontes;
 * - no encerramento para as fontes primeiro e só então esvazia o buffer,
 *   para não perder amostras emitidas durante o shutdown.
 */
@Injectable()
export class IngestionService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(IngestionService.name);
  private readonly sources = new Map<string, AcquisitionSource>();
  private started = false;

  constructor(private readonly buffer: IngestionBuffer) {}

  register(source: AcquisitionSource) {
    if (this.started) {
      throw new Error(`Fonte "${source.name}" registrada após a subida; use onModuleInit.`);
    }
    if (this.sources.has(source.name)) {
      throw new Error(`Já existe uma fonte registrada com o nome "${source.name}".`);
    }
    this.sources.set(source.name, source);
  }

  async onApplicationBootstrap() {
    this.buffer.start();
    for (const source of this.sources.values()) {
      try {
        await source.start((samples) => this.ingest(source.name, samples));
        this.logger.log(`Fonte "${source.name}" iniciada.`);
      } catch (err) {
        // Uma fonte com problema (ex: broker MQTT fora) não derruba as outras.
        this.logger.error(`Fonte "${source.name}" falhou ao iniciar: ${(err as Error).message}`);
      }
    }
    this.started = true;
    if (this.sources.size === 0) this.logger.warn('Nenhuma fonte de aquisição registrada.');
  }

  async onModuleDestroy() {
    for (const source of this.sources.values()) {
      try {
        await source.stop();
      } catch (err) {
        this.logger.error(`Fonte "${source.name}" falhou ao parar: ${(err as Error).message}`);
      }
    }
    await this.buffer.stop();
  }

  /** Normaliza e valida as amostras de uma fonte e as enfileira para gravação. */
  ingest(sourceName: string, inputs: SampleInput[]) {
    const valid: Sample[] = [];
    for (const s of inputs) {
      if (!isValid(s)) continue;
      valid.push({
        time: s.time,
        tag: s.tag,
        value: s.value,
        quality: s.quality ?? QUALITY_GOOD,
        source: sourceName,
      });
    }
    const rejected = inputs.length - valid.length;
    if (rejected > 0) {
      this.logger.warn(`Fonte "${sourceName}": ${rejected} amostra(s) inválida(s) descartada(s).`);
    }
    this.buffer.push(valid);
  }
}

function isValid(s: SampleInput): boolean {
  return (
    typeof s.tag === 'string' &&
    s.tag.length > 0 &&
    Number.isFinite(s.value) &&
    s.time instanceof Date &&
    !Number.isNaN(s.time.getTime()) &&
    (s.quality === undefined || Number.isInteger(s.quality))
  );
}
