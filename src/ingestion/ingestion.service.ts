import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { errorMessage } from '../common/error-message';
import { AcquisitionSource } from './acquisition-source';
import { IngestionBuffer } from './ingestion-buffer';
import { QUALITY_GOOD, Sample, SampleInput } from './sample';

/**
 * Núcleo de ingestão: ponto único por onde todas as fontes entregam dados.
 *
 *   fonte.start(emit) -> ingest() [normaliza + valida] -> IngestionBuffer -> banco
 *                                                       -> samples$ (tempo real)
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
  private readonly live = new Subject<Sample[]>();
  /** Problemas por fonte acumulados desde o último aviso no log. */
  private readonly issues = new Map<
    string,
    { rejected: number; retimed: number; lastReport: number }
  >();

  /**
   * Amostras válidas assim que chegam, antes de irem para o banco: o tempo
   * real (WebSocket) não depende do banco estar no ar.
   */
  readonly samples$: Observable<Sample[]> = this.live.asObservable();

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
        this.logger.error(`Fonte "${source.name}" falhou ao iniciar: ${errorMessage(err)}`);
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
        this.logger.error(`Fonte "${source.name}" falhou ao parar: ${errorMessage(err)}`);
      }
    }
    await this.buffer.stop();
    this.live.complete();
  }

  /**
   * Normaliza e valida as amostras de uma fonte e as enfileira para gravação.
   *
   * - descarta as inválidas (ver isValid): uma única amostra que o banco
   *   recusasse faria o lote inteiro falhar a cada nova tentativa;
   * - sem `time`, usa o instante de recebimento; com um `time` implausível
   *   (relógio de campo zerado ou adiantado), também;
   * - aplica a qualidade padrão e carimba a origem e o recebimento.
   */
  ingest(sourceName: string, inputs: SampleInput[]) {
    const receivedAt = new Date();
    const now = receivedAt.getTime();
    const valid: Sample[] = [];
    let retimed = 0;
    for (const s of inputs) {
      if (!isValid(s)) continue;
      let time = s.time ?? receivedAt;
      const t = time.getTime();
      if (t > now + MAX_FUTURE_MS || t < now - MAX_AGE_MS) {
        time = receivedAt;
        retimed++;
      }
      valid.push({
        time,
        tag: s.tag,
        value: s.value,
        quality: s.quality ?? QUALITY_GOOD,
        source: sourceName,
        receivedAt,
      });
    }
    this.report(sourceName, inputs.length - valid.length, retimed, now);
    this.buffer.push(valid);
    if (valid.length > 0) this.live.next(valid);
  }

  /**
   * Avisa no log sobre amostras descartadas ou com horário corrigido, no
   * máximo uma vez por minuto por fonte (um dispositivo com problema mandando
   * 10 amostras/s não pode inundar o log).
   */
  private report(source: string, rejected: number, retimed: number, now: number) {
    if (rejected === 0 && retimed === 0) return;
    let st = this.issues.get(source);
    if (!st) {
      st = { rejected: 0, retimed: 0, lastReport: -Infinity };
      this.issues.set(source, st);
    }
    st.rejected += rejected;
    st.retimed += retimed;
    if (now - st.lastReport < REPORT_INTERVAL_MS) return;

    const parts: string[] = [];
    if (st.rejected > 0) parts.push(`${st.rejected} amostra(s) inválida(s) descartada(s)`);
    if (st.retimed > 0) {
      parts.push(`${st.retimed} com horário implausível (usado o de recebimento)`);
    }
    const since = st.lastReport === -Infinity ? '' : ' desde o último aviso';
    this.logger.warn(`Fonte "${source}": ${parts.join('; ')}${since}.`);
    st.rejected = 0;
    st.retimed = 0;
    st.lastReport = now;
  }
}

/** Maior nome de tag aceito. */
const MAX_TAG_LENGTH = 200;
/** Tolerância para relógios de campo adiantados. */
const MAX_FUTURE_MS = 5 * 60_000;
/**
 * Idade máxima aceita para uma amostra (dados que chegam atrasados, ex: de um
 * dispositivo com store-and-forward). Igual à janela de reprocessamento do
 * agregado de 1 minuto (migration ContinuousAggregates).
 */
const MAX_AGE_MS = 24 * 60 * 60_000;
const REPORT_INTERVAL_MS = 60_000;

/** Caracteres de controle (inclui o NUL, que o PostgreSQL recusa em TEXT). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isValid(s: SampleInput): boolean {
  return (
    typeof s.tag === 'string' &&
    s.tag.length > 0 &&
    s.tag.length <= MAX_TAG_LENGTH &&
    !CONTROL_CHARS.test(s.tag) &&
    typeof s.value === 'number' &&
    Number.isFinite(s.value) &&
    (s.time === undefined || (s.time instanceof Date && !Number.isNaN(s.time.getTime()))) &&
    (s.quality === undefined || (Number.isInteger(s.quality) && s.quality >= 0 && s.quality <= 255))
  );
}
