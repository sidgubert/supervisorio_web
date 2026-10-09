import { Injectable, Logger } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { ConfigService } from '@nestjs/config';
import { errorMessage } from '../common/error-message';
import { Env } from '../config/env.validation';
import { MeasurementsService } from '../measurements/measurements.service';
import { Sample } from './sample';

/** Máximo de amostras por INSERT, para cada instrução continuar curta. */
const MAX_PER_INSERT = 10_000;

/** Uma gravação em lote concluída. */
export interface InsertEvent {
  samples: Sample[];
  /** Quantas foram de fato inseridas (as já existentes são ignoradas). */
  inserted: number;
  /** Duração do INSERT, em ms. */
  ms: number;
}

/**
 * Buffer em memória entre as fontes e o banco, compartilhado por todas elas.
 *
 * - Grava em lote a cada INGEST_FLUSH_MS, com no máximo um flush por vez. Com
 *   acúmulo, o flush grava vários lotes seguidos (ver drain).
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
  private readonly insertsSubject = new Subject<InsertEvent>();

  /** Cada gravação concluída no banco (para as métricas de desempenho). */
  readonly inserts$: Observable<InsertEvent> = this.insertsSubject.asObservable();

  private readonly flushMs: number;
  private readonly maxBuffer: number;
  private maxPerInsert = MAX_PER_INSERT;

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
    this.inFlight = this.drain().finally(() => (this.inFlight = undefined));
    return this.inFlight;
  }

  /**
   * Grava, em lotes de até maxPerInsert, o que estava no buffer no início do
   * ciclo. Com acúmulo (rajada, banco lento ou que acabou de voltar), os lotes
   * seguem um atrás do outro, e não um por ciclo: senão a vazão máxima seria
   * maxPerInsert / INGEST_FLUSH_MS (5 mil amostras/s com os padrões), mesmo
   * com o banco aguentando mais. O que chega durante a gravação fica para o
   * próximo ciclo. Para na primeira falha.
   */
  private async drain() {
    let remaining = this.buffer.length;
    while (remaining > 0 && this.buffer.length > 0) {
      const size = Math.min(remaining, this.maxPerInsert);
      if (!(await this.writeNext(size))) return;
      remaining -= size;
    }
  }

  /** Grava as `size` amostras mais antigas. Devolve false se o banco falhar. */
  private async writeNext(size: number): Promise<boolean> {
    if (this.dropped > 0) {
      this.logger.warn(`Buffer cheio: ${this.dropped} amostras antigas descartadas.`);
      this.dropped = 0;
    }

    const batch = this.buffer.splice(0, size);
    try {
      const t0 = performance.now();
      const n = await this.measurements.insertBatch(batch);
      this.insertsSubject.next({ samples: batch, inserted: n, ms: performance.now() - t0 });
      // n < batch.length: amostras que o banco já tinha (ex: lote regravado
      // após uma falha cuja confirmação se perdeu) foram ignoradas.
      const dup = batch.length - n;
      this.logger.debug(
        `Gravadas ${n} amostras${dup > 0 ? ` (${dup} já existiam)` : ''} ` +
          `(${this.buffer.length} pendentes).`,
      );
      return true;
    } catch (err) {
      this.buffer = batch.concat(this.buffer);
      this.enforceCap();
      this.logger.error(
        `Falha ao gravar lote (${this.buffer.length} pendentes): ${errorMessage(err)}`,
      );
      return false;
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
