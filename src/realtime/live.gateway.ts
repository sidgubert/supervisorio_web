import { Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Subscription } from 'rxjs';
import { Namespace, Socket } from 'socket.io';
import { errorMessage } from '../common/error-message';
import { Env } from '../config/env.validation';
import { AlarmsService } from '../alarms/alarms.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { Sample } from '../ingestion/sample';

/** Sala de quem assina todas as tags. */
const ALL = '*';
const MAX_TAGS_PER_SUBSCRIBE = 200;

const room = (tag: string) => `tag:${tag}`;

export type SubscribeAck =
  { ok: true; tags: string[] | typeof ALL; last: Sample[] } | { ok: false; error: string };

/**
 * Tempo real para o dashboard (socket.io, namespace /live).
 *
 * Protocolo:
 *   cliente -> 'subscribe'   { tags?: string[] }  (sem tags = todas)
 *              ack: { ok, tags, last }  last = último valor conhecido de cada tag
 *   cliente -> 'unsubscribe' { tags?: string[] }  (sem tags = todas)
 *   servidor -> 'samples'    Sample[]             (um lote por tag a cada LIVE_FLUSH_MS)
 *   servidor -> 'alarm'      { type, alarm }      (a todos os clientes)
 *              type: raised | cleared | acknowledged
 *
 * As amostras vêm do IngestionService.samples$, antes de irem para o banco;
 * os alarmes, do AlarmsService.events$.
 *
 * Envio agrupado: as amostras de cada tag se acumulam e saem num único evento
 * a cada LIVE_FLUSH_MS (0 = na hora), com no máximo LIVE_MAX_SAMPLES_PER_TAG
 * (as mais recentes). Uma fonte rápida (Modbus a 50 ms, MQTT com muitas
 * mensagens) não inunda o navegador; o histórico completo está no banco.
 */
@WebSocketGateway({ namespace: '/live', cors: { origin: '*' } })
export class LiveGateway implements OnGatewayInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveGateway.name);
  /** Último valor de cada tag, para o cliente não começar com o gráfico vazio. */
  private readonly last = new Map<string, Sample>();
  private subscriptions: Subscription[] = [];
  /** Amostras aguardando o próximo envio, por tag. */
  private readonly pending = new Map<string, Sample[]>();
  private flushTimer?: NodeJS.Timeout;
  private readonly flushMs: number;
  private readonly maxPerTag: number;

  @WebSocketServer()
  server!: Namespace;

  constructor(
    private readonly ingestion: IngestionService,
    private readonly alarms: AlarmsService,
    config: ConfigService<Env, true>,
  ) {
    this.flushMs = config.get('LIVE_FLUSH_MS', { infer: true });
    this.maxPerTag = config.get('LIVE_MAX_SAMPLES_PER_TAG', { infer: true });
  }

  afterInit() {
    this.subscriptions = [
      this.ingestion.samples$.subscribe((batch) => this.broadcast(batch)),
      // Alarmes vão para todos os clientes: a lista de alarmes é global.
      this.alarms.events$.subscribe((event) => this.server.emit('alarm', event)),
    ];
  }

  onModuleDestroy() {
    for (const s of this.subscriptions) s.unsubscribe();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  @SubscribeMessage('subscribe')
  async subscribe(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    const parsed = parseTags(body);
    if ('error' in parsed) return { ok: false, error: parsed.error } satisfies SubscribeAck;

    if (parsed.tags === ALL) {
      await client.join(ALL);
      return { ok: true, tags: ALL, last: [...this.last.values()] } satisfies SubscribeAck;
    }
    await client.join(parsed.tags.map(room));
    const last = parsed.tags.flatMap((t) => this.last.get(t) ?? []);
    return { ok: true, tags: parsed.tags, last } satisfies SubscribeAck;
  }

  @SubscribeMessage('unsubscribe')
  async unsubscribe(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    const parsed = parseTags(body);
    if ('error' in parsed) return { ok: false, error: parsed.error };

    const rooms =
      parsed.tags === ALL
        ? [...client.rooms].filter((r) => r !== client.id)
        : parsed.tags.map(room);
    // leave() é síncrono no adaptador em memória, mas pode ser assíncrono em
    // adaptadores distribuídos (ex: Redis).
    for (const r of rooms) await client.leave(r);
    return { ok: true };
  }

  /** Acumula o lote por tag e agenda o envio. */
  broadcast(batch: Sample[]) {
    for (const s of batch) {
      this.last.set(s.tag, s);
      const list = this.pending.get(s.tag);
      if (list) {
        list.push(s);
        // Mantém só as mais recentes.
        if (list.length > this.maxPerTag) list.splice(0, list.length - this.maxPerTag);
      } else {
        this.pending.set(s.tag, [s]);
      }
    }
    if (this.flushMs === 0) this.flush();
    else this.flushTimer ??= setTimeout(() => this.flush(), this.flushMs);
  }

  /** Envia o acumulado de cada tag para quem assina a tag ou todas. */
  private flush() {
    this.flushTimer = undefined;
    try {
      for (const [tag, samples] of this.pending) {
        // Um único emit para as duas salas: o socket.io não duplica para quem
        // está em ambas.
        this.server.to([room(tag), ALL]).emit('samples', samples);
      }
    } catch (err) {
      // Um erro aqui não pode interromper a assinatura de samples$.
      this.logger.error(`Falha ao transmitir amostras: ${errorMessage(err)}`);
    } finally {
      this.pending.clear();
    }
  }
}

function parseTags(body: unknown): { tags: string[] | typeof ALL } | { error: string } {
  if (body === undefined || body === null) return { tags: ALL };
  if (typeof body !== 'object') return { error: 'payload deve ser { tags?: string[] }' };
  const tags = (body as { tags?: unknown }).tags;
  if (tags === undefined) return { tags: ALL };
  if (
    !Array.isArray(tags) ||
    !tags.every((t): t is string => typeof t === 'string' && t.length > 0)
  ) {
    return { error: 'tags deve ser uma lista de nomes de tag' };
  }
  if (tags.length === 0) return { tags: ALL };
  if (tags.length > MAX_TAGS_PER_SUBSCRIBE) {
    return { error: `no máximo ${MAX_TAGS_PER_SUBSCRIBE} tags por assinatura` };
  }
  return { tags: [...new Set(tags)] };
}
