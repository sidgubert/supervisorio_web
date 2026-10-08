import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Subscription } from 'rxjs';
import { InsertEvent } from '../ingestion/ingestion-buffer';
import { IngestionService } from '../ingestion/ingestion.service';

/** Janela das taxas (amostras/s, lotes/s), em segundos. */
export const WINDOW_SEC = 60;
/** Quantas latências recentes entram na média por fonte. */
const LATENCY_SAMPLES = 100;
/** Fontes sempre listadas, mesmo sem dados. */
const KNOWN_SOURCES = ['sim', 'mqtt', 'modbus', 'opcua'];

export interface SourceMetrics {
  /** Média de amostras gravadas por segundo na janela. */
  samplesPerSec: number;
  /** Média de lotes (INSERT) com amostras da fonte por segundo na janela. */
  batchesPerSec: number;
  /** Média das últimas latências de INSERT dos lotes com amostras da fonte, em ms. */
  avgInsertMs: number;
  totalSamples: number;
  lastBatchAt: string | null;
}

export interface IngestSnapshot {
  uptimeSec: number;
  totalSamples: number;
  totalBatches: number;
  avgInsertMs: number;
  bySource: Record<string, SourceMetrics>;
  sseClients: number;
  sseEventsSent: number;
  wsClients: number;
  wsEventsSent: number;
}

/** Contador com janela deslizante, em baldes de 1 segundo. */
class SlidingCounter {
  private readonly buckets = new Map<number, number>();

  add(n: number, nowMs: number) {
    const sec = Math.floor(nowMs / 1000);
    this.buckets.set(sec, (this.buckets.get(sec) ?? 0) + n);
    this.prune(sec);
  }

  /** Soma da janela (os últimos WINDOW_SEC segundos, incluindo o atual). */
  sum(nowMs: number): number {
    const sec = Math.floor(nowMs / 1000);
    this.prune(sec);
    let total = 0;
    for (const v of this.buckets.values()) total += v;
    return total;
  }

  private prune(sec: number) {
    for (const key of this.buckets.keys()) if (key <= sec - WINDOW_SEC) this.buckets.delete(key);
  }
}

interface SourceState {
  samples: SlidingCounter;
  batches: SlidingCounter;
  latencies: number[];
  total: number;
  lastBatchAt: Date | null;
}

/**
 * Métricas de desempenho em memória (Fase 5):
 *
 * - por fonte: amostras/s e lotes/s numa janela deslizante de 60 s, latência
 *   média das últimas 100 gravações e totais desde a subida;
 * - clientes conectados e eventos enviados no tempo real (SSE e WebSocket).
 *
 * As gravações chegam por IngestionService.inserts$. Os contadores por segundo
 * são calculados a partir do relógio na hora da consulta, sem timer.
 */
@Injectable()
export class MetricsCollectorService implements OnModuleInit, OnModuleDestroy {
  private readonly startedAt = Date.now();
  private readonly sources = new Map<string, SourceState>();
  private totalSamples = 0;
  private totalBatches = 0;
  private totalInsertMs = 0;
  private sseClients = 0;
  private sseEventsSent = 0;
  private wsClients = 0;
  private wsEventsSent = 0;
  private subscription?: Subscription;

  constructor(private readonly ingestion: IngestionService) {
    for (const s of KNOWN_SOURCES) this.state(s);
  }

  onModuleInit() {
    this.subscription = this.ingestion.inserts$.subscribe((e) => this.recordInsert(e));
  }

  onModuleDestroy() {
    this.subscription?.unsubscribe();
  }

  recordInsert(e: InsertEvent, nowMs = Date.now()) {
    if (e.samples.length === 0) return;
    this.totalBatches++;
    this.totalSamples += e.inserted;
    this.totalInsertMs += e.ms;

    const bySource = new Map<string, number>();
    for (const s of e.samples) bySource.set(s.source, (bySource.get(s.source) ?? 0) + 1);
    for (const [source, count] of bySource) {
      const st = this.state(source);
      st.samples.add(count, nowMs);
      st.batches.add(1, nowMs);
      st.latencies.push(e.ms);
      if (st.latencies.length > LATENCY_SAMPLES) st.latencies.shift();
      st.total += count;
      st.lastBatchAt = new Date(nowMs);
    }
  }

  sseConnected() {
    this.sseClients++;
  }

  sseDisconnected() {
    this.sseClients = Math.max(0, this.sseClients - 1);
  }

  sseSent(events: number) {
    this.sseEventsSent += events;
  }

  wsConnected() {
    this.wsClients++;
  }

  wsDisconnected() {
    this.wsClients = Math.max(0, this.wsClients - 1);
  }

  wsSent(events: number) {
    this.wsEventsSent += events;
  }

  snapshot(nowMs = Date.now()): IngestSnapshot {
    // Logo após a subida a janela ainda não tem 60 s: divide pelo tempo decorrido.
    const window = Math.min(WINDOW_SEC, Math.max(1, Math.ceil((nowMs - this.startedAt) / 1000)));
    const bySource: Record<string, SourceMetrics> = {};
    for (const [source, st] of this.sources) {
      bySource[source] = {
        samplesPerSec: round(st.samples.sum(nowMs) / window),
        batchesPerSec: round(st.batches.sum(nowMs) / window),
        avgInsertMs: round(mean(st.latencies)),
        totalSamples: st.total,
        lastBatchAt: st.lastBatchAt?.toISOString() ?? null,
      };
    }
    return {
      uptimeSec: Math.floor((nowMs - this.startedAt) / 1000),
      totalSamples: this.totalSamples,
      totalBatches: this.totalBatches,
      avgInsertMs: this.totalBatches > 0 ? round(this.totalInsertMs / this.totalBatches) : 0,
      bySource,
      sseClients: this.sseClients,
      sseEventsSent: this.sseEventsSent,
      wsClients: this.wsClients,
      wsEventsSent: this.wsEventsSent,
    };
  }

  private state(source: string): SourceState {
    let st = this.sources.get(source);
    if (!st) {
      st = {
        samples: new SlidingCounter(),
        batches: new SlidingCounter(),
        latencies: [],
        total: 0,
        lastBatchAt: null,
      };
      this.sources.set(source, st);
    }
    return st;
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (n: number) => Math.round(n * 100) / 100;
