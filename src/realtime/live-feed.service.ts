import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable, Subject, Subscription } from 'rxjs';
import { errorMessage } from '../common/error-message';
import { Env } from '../config/env.validation';
import { IngestionService } from '../ingestion/ingestion.service';
import { Sample } from '../ingestion/sample';
import { TagsService } from '../tags/tags.service';

/**
 * Fluxo de tempo real compartilhado pelo WebSocket (LiveGateway) e pelo SSE
 * (DashboardController).
 *
 * As amostras de IngestionService.samples$ se acumulam por tag e saem juntas a
 * cada LIVE_FLUSH_MS (0 = na hora), com no máximo LIVE_MAX_SAMPLES_PER_TAG por
 * tag (as mais recentes). Uma fonte rápida não inunda o navegador; o
 * histórico completo está no banco. Também guarda o último valor de cada tag,
 * para um cliente novo não começar com a tela vazia.
 *
 * Só passam as tags do cadastro: as geradas pelo simulador para teste de
 * carga (SIM_TAGS acima de 4) são gravadas no banco, mas não vão para a tela;
 * senão o navegador receberia milhares de eventos por segundo.
 */
@Injectable()
export class LiveFeedService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveFeedService.name);
  /** Nomes das tags do cadastro. */
  private known = new Set<string>();
  private reloading: Promise<void> = Promise.resolve();
  private readonly last = new Map<string, Sample>();
  private readonly pending = new Map<string, Sample[]>();
  private readonly flushes = new Subject<Sample[][]>();
  private timer?: NodeJS.Timeout;
  private subscriptions: Subscription[] = [];
  private readonly flushMs: number;
  private readonly maxPerTag: number;

  /** Cada envio: uma lista de lotes, um por tag. */
  readonly batches$: Observable<Sample[][]> = this.flushes.asObservable();

  constructor(
    private readonly ingestion: IngestionService,
    config: ConfigService<Env, true>,
    private readonly tags: TagsService,
  ) {
    this.flushMs = config.get('LIVE_FLUSH_MS', { infer: true });
    this.maxPerTag = config.get('LIVE_MAX_SAMPLES_PER_TAG', { infer: true });
  }

  async onModuleInit() {
    await this.reloadTags();
    this.subscriptions = [
      this.ingestion.samples$.subscribe((batch) => this.push(batch)),
      this.tags.changes$.subscribe(() => {
        this.reloading = this.reloading
          .then(() => this.reloadTags())
          .catch((err) => this.logger.error(`Falha ao reler o cadastro: ${errorMessage(err)}`));
      }),
    ];
  }

  /** Relê os nomes do cadastro e esquece o que guardava de tags removidas. */
  private async reloadTags() {
    this.known = new Set((await this.tags.findAll()).map((t) => t.tag));
    for (const tag of [...this.last.keys()]) {
      if (this.known.has(tag)) continue;
      this.last.delete(tag);
      this.pending.delete(tag);
    }
  }

  onModuleDestroy() {
    for (const s of this.subscriptions) s.unsubscribe();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.flushes.complete();
  }

  /** Último valor conhecido de cada tag pedida (todas, sem filtro). */
  lastValues(tags?: readonly string[]): Sample[] {
    if (!tags) return [...this.last.values()];
    return tags.flatMap((t) => this.last.get(t) ?? []);
  }

  push(batch: Sample[]) {
    for (const s of batch) {
      if (!this.known.has(s.tag)) continue;
      this.last.set(s.tag, s);
      const list = this.pending.get(s.tag);
      if (list) {
        list.push(s);
        if (list.length > this.maxPerTag) list.splice(0, list.length - this.maxPerTag);
      } else {
        this.pending.set(s.tag, [s]);
      }
    }
    if (this.flushMs === 0) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), this.flushMs);
  }

  private flush() {
    this.timer = undefined;
    if (this.pending.size === 0) return;
    const batches = [...this.pending.values()];
    this.pending.clear();
    this.flushes.next(batches);
  }
}
