import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { errorMessage } from '../common/error-message';
import { Env } from '../config/env.validation';
import { MeasurementsService } from '../measurements/measurements.service';
import { Sample } from './sample';

/** Máximo de amostras gravadas por flush, para manter cada ciclo curto. */
const MAX_PER_FLUSH = 10_000;

/**
 * Buffer em memória entre as fontes e o banco, compartilhado por todas elas.
 *
 * - Grava em lote a cada INGEST_FLUSH_MS, com no máximo um flush por vez.
 * - Se o banco falhar, as amostras voltam ao início do buffer (mantendo a
 *   ordem) e são regravadas no próximo ciclo.
 * - O buffer tem teto (INGEST_BUFFER_MAX): com o banco fora por muito tempo,
 *   as amostras mais antigas são descartadas, com aviso no log.
 *
 * O ciclo de vida (start/stop) é controlado pelo IngestionService.
 */
@Injectable()
export class IngestionBuffer {
  private readonly logger = new Logger(IngestionBuffer.name);
  private buffer: Sample[] = [];
  private timer?: NodeJS.Timeout;
  /** Gravação em andamento; impede dois flush simultâneos. */
  private inFlight?: Promise<void>;
  /** Amostras descartadas desde o último aviso no log. */
  private dropped = 0;

  private readonly flushMs: number;
  private readonly maxBuffer: number;
  private maxPerFlush = MAX_PER_FLUSH;

  constructor(
    config: ConfigService<Env, true>,
    private readonly measurements: MeasurementsService,
  ) {
    this.flushMs = config.get('INGEST_FLUSH_MS', { infer: true });
    this.maxBuffer = config.get('INGEST_BUFFER_MAX', { infer: true });
  }

  /** Amostras aguardando gravação. */
  get pending(): number {
    return this.buffer.length;
  }

  push(samples: Sample[]) {
    // Laço em vez de push(...samples): spread de arrays grandes estoura a pilha.
    for (const s of samples) this.buffer.push(s);
    this.enforceCap();
  }

  /** Inicia o flush periódico. */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.flushMs);
  }

  /** Para o flush periódico e grava o que restou no buffer. */
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
    while (this.buffer.length > 0) {
      const before = this.buffer.length;
      await this.flush();
      if (this.buffer.length >= before) break; // banco indisponível: desiste
    }
  }

  flush(): Promise<void> {
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
      this.buffer = batch.concat(this.buffer);
      this.enforceCap();
      this.logger.error(
        `Falha ao gravar lote (${this.buffer.length} pendentes): ${errorMessage(err)}`,
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
