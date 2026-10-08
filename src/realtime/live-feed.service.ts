import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable, Subject, Subscription } from 'rxjs';
import { Env } from '../config/env.validation';
import { IngestionService } from '../ingestion/ingestion.service';
import { Sample } from '../ingestion/sample';

/**
 * Fluxo de tempo real compartilhado pelo WebSocket (LiveGateway) e pelo SSE
 * (DashboardController).
 *
 * As amostras de IngestionService.samples$ se acumulam por tag e saem juntas a
 * cada LIVE_FLUSH_MS (0 = na hora), com no máximo LIVE_MAX_SAMPLES_PER_TAG por
 * tag (as mais recentes). Uma fonte rápida não inunda o navegador; o
 * histórico completo está no banco. Também guarda o último valor de cada tag,
 * para um cliente novo não começar com a tela vazia.
 */
@Injectable()
export class LiveFeedService implements OnModuleInit, OnModuleDestroy {
  private readonly last = new Map<string, Sample>();
  private readonly pending = new Map<string, Sample[]>();
  private readonly flushes = new Subject<Sample[][]>();
  private timer?: NodeJS.Timeout;
  private subscription?: Subscription;
  private readonly flushMs: number;
  private readonly maxPerTag: number;

  /** Cada envio: uma lista de lotes, um por tag. */
  readonly batches$: Observable<Sample[][]> = this.flushes.asObservable();

  constructor(
    private readonly ingestion: IngestionService,
    config: ConfigService<Env, true>,
  ) {
    this.flushMs = config.get('LIVE_FLUSH_MS', { infer: true });
    this.maxPerTag = config.get('LIVE_MAX_SAMPLES_PER_TAG', { infer: true });
  }

  onModuleInit() {
    this.subscription = this.ingestion.samples$.subscribe((batch) => this.push(batch));
  }

  onModuleDestroy() {
    this.subscription?.unsubscribe();
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
