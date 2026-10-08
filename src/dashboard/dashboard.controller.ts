import { Controller, Get, MessageEvent, Sse } from '@nestjs/common';
import { interval, Observable } from 'rxjs';
import { AlarmsService } from '../alarms/alarms.service';
import { Sample } from '../ingestion/sample';
import { LatestSample, MeasurementsService } from '../measurements/measurements.service';
import { MetricsCollectorService } from '../metrics/metrics-collector.service';
import { LiveFeedService } from '../realtime/live-feed.service';
import { TagsService } from '../tags/tags.service';

/** Intervalo do "ping" no SSE: mantém a conexão viva através de proxies. */
export const KEEPALIVE_MS = 25_000;

/**
 * Rotas do dashboard web (Fases 3–4).
 *
 * O tempo real usa Server-Sent Events: uma conexão HTTP que fica aberta e
 * recebe eventos do servidor. É mais simples que WebSocket (só servidor →
 * cliente, reconexão automática no navegador) e basta para um painel.
 */
@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly measurements: MeasurementsService,
    private readonly alarms: AlarmsService,
    private readonly tags: TagsService,
    private readonly feed: LiveFeedService,
    private readonly metrics: MetricsCollectorService,
  ) {}

  /**
   * Último valor de cada tag: o do banco, ou o que acabou de chegar (ainda no
   * buffer de gravação), o que for mais recente.
   */
  @Get('tags')
  async tagsSnapshot(): Promise<LatestSample[]> {
    const byTag = new Map((await this.measurements.latestPerTag()).map((s) => [s.tag, s]));
    for (const s of this.feed.lastValues()) {
      const db = byTag.get(s.tag);
      if (!db || new Date(db.time) < s.time) byTag.set(s.tag, toLatest(s));
    }
    return [...byTag.values()].sort((a, b) => a.tag.localeCompare(b.tag));
  }

  /** Alarmes abertos e o cadastro de tags (unidades, limites, sinótico). */
  @Get('alarms')
  async alarmsSnapshot() {
    return { alarms: this.alarms.list(), tags: await this.tags.findAll() };
  }

  /**
   * Stream SSE. Cada evento traz um JSON com `type`:
   *   sample: { tag, value, quality, source, time }
   *   alarm:  { change: raised | cleared | acknowledged, alarm }
   *   ping:   a cada KEEPALIVE_MS, sem conteúdo
   * As amostras saem agrupadas a cada LIVE_FLUSH_MS (LiveFeedService).
   */
  @Sse('stream')
  stream(): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      this.metrics.sseConnected();
      const subscriptions = [
        this.feed.batches$.subscribe((batches) => {
          let sent = 0;
          for (const samples of batches) {
            for (const s of samples) {
              subscriber.next({ data: { type: 'sample', ...toLatest(s) } });
              sent++;
            }
          }
          this.metrics.sseSent(sent);
        }),
        this.alarms.events$.subscribe((e) => {
          subscriber.next({ data: { type: 'alarm', change: e.type, alarm: e.alarm } });
          this.metrics.sseSent(1);
        }),
        interval(KEEPALIVE_MS).subscribe(() => subscriber.next({ data: { type: 'ping' } })),
      ];
      return () => {
        for (const s of subscriptions) s.unsubscribe();
        this.metrics.sseDisconnected();
      };
    });
  }
}

function toLatest(s: Sample): LatestSample {
  return { tag: s.tag, value: s.value, quality: s.quality, source: s.source, time: s.time };
}
