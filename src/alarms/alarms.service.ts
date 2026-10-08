import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Observable, Subject, Subscription } from 'rxjs';
import { Between, IsNull, Repository } from 'typeorm';
import { errorMessage } from '../common/error-message';
import { RateLimitedLogger } from '../common/rate-limited-logger';
import { Env } from '../config/env.validation';
import { IngestionService } from '../ingestion/ingestion.service';
import { QUALITY_BAD, Sample } from '../ingestion/sample';
import { TagsService } from '../tags/tags.service';
import { Alarm } from './alarm.entity';
import { AlarmLevel, AlarmLimits, configuredLevels, evaluate, LEVEL_PRIORITY } from './alarm-rules';

export type AlarmState = 'ACTIVE_UNACKED' | 'ACTIVE_ACKED' | 'CLEARED_UNACKED' | 'CLOSED';

/** Ocorrência com o estado derivado, como a API e o WebSocket a entregam. */
export type AlarmView = Alarm & { state: AlarmState; priority: number };

export interface AlarmEvent {
  type: 'raised' | 'cleared' | 'acknowledged';
  alarm: AlarmView;
}

/** Transição a gravar no banco. */
type Op =
  | { kind: 'raise'; alarm: Alarm }
  | { kind: 'clear'; id: string; at: Date; value: number | null }
  | { kind: 'ack'; id: string; at: Date; by: string };

/** Teto da fila de gravação (com o banco fora por muito tempo). */
const MAX_OUTBOX = 10_000;
const MAX_RETRY_MS = 30_000;

/**
 * Motor de alarmes.
 *
 * - Avalia cada amostra (exceto as de qualidade Bad, cujo valor é velho)
 *   contra os limites da tag no cadastro (alarm-rules.ts).
 * - O estado vive em memória: a lista de alarmes abertos e as transições
 *   funcionam mesmo com o banco fora, como o tempo real.
 * - As transições (ativou, normalizou, reconhecido) vão para uma fila de
 *   gravação, em ordem e com nova tentativa; os ids são gerados aqui (UUID),
 *   então nada depende de o banco responder na hora. As gravações são
 *   idempotentes (repetir uma não muda o resultado).
 * - Na subida, recarrega do banco os alarmes abertos.
 */
@Injectable()
export class AlarmsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlarmsService.name);
  private readonly rateLimited = new RateLimitedLogger(this.logger);
  /** Ocorrências abertas (ativas ou não reconhecidas), por id. */
  private readonly open = new Map<string, Alarm>();
  /** Ocorrências ativas, por "tag|nível". */
  private readonly active = new Map<string, Alarm>();
  /** Limites por tag (só tags habilitadas com algum limite). */
  private limits = new Map<string, AlarmLimits>();
  private readonly outbox: Op[] = [];
  private writing?: Promise<void>;
  private retryTimer?: NodeJS.Timeout;
  private retryMs = 1000;
  private reloading: Promise<void> = Promise.resolve();
  private subscriptions: Subscription[] = [];
  private readonly eventsSubject = new Subject<AlarmEvent>();

  /** Transições, para o WebSocket. */
  readonly events$: Observable<AlarmEvent> = this.eventsSubject.asObservable();

  constructor(
    @InjectRepository(Alarm)
    private readonly repo: Repository<Alarm>,
    private readonly ingestion: IngestionService,
    private readonly tags: TagsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async onModuleInit() {
    const open = await this.repo.find({ where: [{ clearedAt: IsNull() }, { ackedAt: IsNull() }] });
    for (const alarm of open) {
      this.open.set(alarm.id, alarm);
      if (!alarm.clearedAt) this.active.set(key(alarm.tag, alarm.level), alarm);
    }
    // Depois dos abertos: um ativo cujo limite foi apagado com a API parada
    // é normalizado já aqui.
    await this.reloadLimits();
    this.subscriptions = [
      this.ingestion.samples$.subscribe((batch) => this.onSamples(batch)),
      this.tags.changes$.subscribe(() => this.scheduleReload()),
    ];
    this.logger.log(
      `${this.limits.size} tag(s) com limites de alarme; ${this.open.size} alarme(s) aberto(s).`,
    );
  }

  async onModuleDestroy() {
    for (const s of this.subscriptions) s.unsubscribe();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    await this.reloading;
    await this.writing;
    // Última tentativa de gravar o que ficou na fila.
    if (this.outbox.length > 0) await this.drain();
    if (this.outbox.length > 0) {
      this.logger.error(`${this.outbox.length} transição(ões) de alarme não gravada(s).`);
    }
    this.eventsSubject.complete();
  }

  /** Alarmes abertos: mais graves primeiro, depois os mais recentes. */
  list(): AlarmView[] {
    return [...this.open.values()]
      .map(view)
      .sort((a, b) => b.priority - a.priority || b.raisedAt.getTime() - a.raisedAt.getTime());
  }

  /** Histórico do banco (inclui os já encerrados). */
  history(q: { from: Date; to: Date; tag?: string; limit: number }): Promise<AlarmView[]> {
    return this.repo
      .find({
        where: { raisedAt: Between(q.from, q.to), ...(q.tag ? { tag: q.tag } : {}) },
        order: { raisedAt: 'DESC' },
        take: q.limit,
      })
      .then((rows) => rows.map(view));
  }

  /** Reconhece um alarme aberto, registrando quem (repetir não muda nada). */
  ack(id: string, by: string): AlarmView {
    const alarm = this.open.get(id);
    if (!alarm) throw new NotFoundException(`Alarme ${id} não está aberto`);
    this.acknowledge(alarm, new Date(), by);
    return view(alarm);
  }

  /** Reconhece todos os alarmes abertos; devolve quantos eram não reconhecidos. */
  ackAll(by: string): number {
    const now = new Date();
    const pending = [...this.open.values()].filter((a) => !a.ackedAt);
    for (const alarm of pending) this.acknowledge(alarm, now, by);
    return pending.length;
  }

  private onSamples(batch: Sample[]) {
    for (const s of batch) {
      if (s.quality === QUALITY_BAD) continue;
      const limits = this.limits.get(s.tag);
      const activeLevels = this.activeLevels(s.tag);
      if (!limits && activeLevels.size === 0) continue;
      const { raise, clear } = evaluate(
        limits ?? {},
        activeLevels,
        s.value,
        this.config.get('ALARM_HYSTERESIS_PCT', { infer: true }),
      );
      for (const level of clear) this.clear(this.active.get(key(s.tag, level))!, s.time, s.value);
      for (const { level, limit } of raise) this.raise(s.tag, level, limit, s.time, s.value);
    }
  }

  private raise(tag: string, level: AlarmLevel, limit: number, at: Date, value: number) {
    const alarm: Alarm = {
      id: randomUUID(),
      tag,
      level,
      limitValue: limit,
      raisedAt: at,
      raisedValue: value,
      clearedAt: null,
      clearedValue: null,
      ackedAt: null,
      ackedBy: null,
    };
    this.open.set(alarm.id, alarm);
    this.active.set(key(tag, level), alarm);
    this.logger.warn(`Alarme ${level} em ${tag}: ${value} (limite ${limit}).`);
    this.enqueue({ kind: 'raise', alarm: { ...alarm } });
    this.publish('raised', alarm);
  }

  private clear(alarm: Alarm, at: Date, value: number | null) {
    alarm.clearedAt = at;
    alarm.clearedValue = value;
    this.active.delete(key(alarm.tag, alarm.level));
    if (alarm.ackedAt) this.open.delete(alarm.id);
    this.logger.log(
      `Alarme ${alarm.level} em ${alarm.tag} normalizado${value === null ? '' : ` (${value})`}.`,
    );
    this.enqueue({ kind: 'clear', id: alarm.id, at, value });
    this.publish('cleared', alarm);
  }

  private acknowledge(alarm: Alarm, at: Date, by: string) {
    if (alarm.ackedAt) return;
    alarm.ackedAt = at;
    alarm.ackedBy = by;
    if (alarm.clearedAt) this.open.delete(alarm.id);
    this.logger.log(`Alarme ${alarm.level} em ${alarm.tag} reconhecido por ${by}.`);
    this.enqueue({ kind: 'ack', id: alarm.id, at, by });
    this.publish('acknowledged', alarm);
  }

  private publish(type: AlarmEvent['type'], alarm: Alarm) {
    this.eventsSubject.next({ type, alarm: view(alarm) });
  }

  private activeLevels(tag: string): Set<AlarmLevel> {
    const levels = new Set<AlarmLevel>();
    for (const alarm of this.active.values()) if (alarm.tag === tag) levels.add(alarm.level);
    return levels;
  }

  private scheduleReload() {
    this.reloading = this.reloading
      .then(() => this.reloadLimits())
      .catch((err) => this.logger.error(`Falha ao recarregar limites: ${errorMessage(err)}`));
  }

  /**
   * Relê os limites do cadastro. Alarmes ativos cujo limite deixou de existir
   * (limite apagado, tag desabilitada ou removida) são normalizados.
   */
  private async reloadLimits() {
    const next = new Map<string, AlarmLimits>();
    for (const t of await this.tags.findAll()) {
      if (t.enabled && configuredLevels(t).size > 0) next.set(t.tag, t);
    }
    this.limits = next;
    const now = new Date();
    for (const alarm of [...this.active.values()]) {
      const limits = next.get(alarm.tag);
      if (!limits || !configuredLevels(limits).has(alarm.level)) this.clear(alarm, now, null);
    }
  }

  // ---- fila de gravação ----

  private enqueue(op: Op) {
    this.outbox.push(op);
    if (this.outbox.length > MAX_OUTBOX) {
      this.outbox.shift();
      this.rateLimited.error('overflow', 'Fila de alarmes cheia: transições antigas descartadas.');
    }
    this.kick();
  }

  private kick() {
    if (this.writing || this.retryTimer) return;
    this.writing = this.drain().finally(() => (this.writing = undefined));
  }

  /** Grava a fila em ordem; numa falha, para e tenta de novo com espera crescente. */
  private async drain() {
    while (this.outbox.length > 0) {
      try {
        await this.write(this.outbox[0]);
        this.outbox.shift();
        this.retryMs = 1000;
        this.rateLimited.reset('db');
      } catch (err) {
        this.rateLimited.error(
          'db',
          `Falha ao gravar alarmes (${this.outbox.length} pendente(s)): ${errorMessage(err)}`,
        );
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          this.kick();
        }, this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
        return;
      }
    }
  }

  /** Gravações idempotentes: repetir uma (após falha) não muda o resultado. */
  private write(op: Op): Promise<unknown> {
    switch (op.kind) {
      case 'raise': {
        const a = op.alarm;
        return this.repo.query(
          `INSERT INTO alarms (id, tag, level, limit_value, raised_at, raised_value)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
          [a.id, a.tag, a.level, a.limitValue, a.raisedAt, a.raisedValue],
        );
      }
      case 'clear':
        return this.repo.query(
          `UPDATE alarms SET cleared_at = $2, cleared_value = $3 WHERE id = $1 AND cleared_at IS NULL`,
          [op.id, op.at, op.value],
        );
      case 'ack':
        return this.repo.query(
          `UPDATE alarms SET acked_at = $2, acked_by = $3 WHERE id = $1 AND acked_at IS NULL`,
          [op.id, op.at, op.by],
        );
    }
  }
}

const key = (tag: string, level: AlarmLevel) => `${tag}|${level}`;

function view(alarm: Alarm): AlarmView {
  const state: AlarmState = !alarm.clearedAt
    ? alarm.ackedAt
      ? 'ACTIVE_ACKED'
      : 'ACTIVE_UNACKED'
    : alarm.ackedAt
      ? 'CLOSED'
      : 'CLEARED_UNACKED';
  return { ...alarm, state, priority: LEVEL_PRIORITY[alarm.level] };
}
