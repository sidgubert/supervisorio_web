import { Logger, OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Subscription } from 'rxjs';
import { Namespace, Socket } from 'socket.io';
import { AlarmsService } from '../alarms/alarms.service';
import { AuthService } from '../auth/auth.service';
import { errorMessage } from '../common/error-message';
import { Sample } from '../ingestion/sample';
import { MetricsCollectorService } from '../metrics/metrics-collector.service';
import { LiveFeedService } from './live-feed.service';

/** Sala de quem assina todas as tags. */
const ALL = '*';
const MAX_TAGS_PER_SUBSCRIBE = 200;

const room = (tag: string) => `tag:${tag}`;

export type SubscribeAck =
  { ok: true; tags: string[] | typeof ALL; last: Sample[] } | { ok: false; error: string };

/**
 * Tempo real por WebSocket (socket.io, namespace /live). O dashboard web usa o
 * SSE (DashboardController); este canal serve a clientes que preferem
 * WebSocket, com assinatura por tag.
 *
 * Protocolo:
 *   conexão  -> com AUTH_ENABLED=true, o token vai em `auth: { token }`
 *   cliente  -> 'subscribe'   { tags?: string[] }  (sem tags = todas)
 *              ack: { ok, tags, last }  last = último valor conhecido de cada tag
 *   cliente  -> 'unsubscribe' { tags?: string[] }  (sem tags = todas)
 *   servidor -> 'samples'    Sample[]             (um lote por tag a cada LIVE_FLUSH_MS)
 *   servidor -> 'alarm'      { type, alarm }      (a todos os clientes)
 *              type: raised | cleared | acknowledged
 */
@WebSocketGateway({ namespace: '/live', cors: { origin: '*' } })
export class LiveGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(LiveGateway.name);
  private subscriptions: Subscription[] = [];

  @WebSocketServer()
  server!: Namespace;

  constructor(
    private readonly feed: LiveFeedService,
    private readonly alarms: AlarmsService,
    private readonly auth: AuthService,
    private readonly metrics: MetricsCollectorService,
  ) {}

  afterInit() {
    this.subscriptions = [
      this.feed.batches$.subscribe((batches) => this.broadcast(batches)),
      // Alarmes vão para todos os clientes: a lista de alarmes é global.
      this.alarms.events$.subscribe((event) => {
        if (!this.hasClients()) return;
        this.server.emit('alarm', event);
        this.metrics.wsSent(1);
      }),
    ];
  }

  onModuleDestroy() {
    for (const s of this.subscriptions) s.unsubscribe();
  }

  /** Com a autenticação ligada, recusa conexões sem token válido. */
  handleConnection(client: Socket) {
    const handshake = client.handshake as {
      auth?: Record<string, unknown>;
      query?: Record<string, unknown>;
    };
    const token = handshake.auth?.token ?? handshake.query?.token;
    if (!this.auth.validateToken(typeof token === 'string' ? token : undefined)) {
      client.emit('error', { message: 'Autenticação necessária.' });
      client.disconnect(true);
      return;
    }
    (client.data as { counted?: boolean }).counted = true;
    this.metrics.wsConnected();
  }

  handleDisconnect(client: Socket) {
    if ((client.data as { counted?: boolean }).counted) this.metrics.wsDisconnected();
  }

  @SubscribeMessage('subscribe')
  async subscribe(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    const parsed = parseTags(body);
    if ('error' in parsed) return { ok: false, error: parsed.error } satisfies SubscribeAck;

    if (parsed.tags === ALL) {
      await client.join(ALL);
      return { ok: true, tags: ALL, last: this.feed.lastValues() } satisfies SubscribeAck;
    }
    await client.join(parsed.tags.map(room));
    return {
      ok: true,
      tags: parsed.tags,
      last: this.feed.lastValues(parsed.tags),
    } satisfies SubscribeAck;
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

  /** Sem nenhum cliente conectado, não há o que transmitir (nem contar). */
  private hasClients() {
    return this.server.sockets.size > 0;
  }

  /** Envia o lote de cada tag para quem assina a tag ou todas. */
  private broadcast(batches: Sample[][]) {
    if (!this.hasClients()) return;
    try {
      for (const samples of batches) {
        // Um único emit para as duas salas: o socket.io não duplica para quem
        // está em ambas.
        this.server.to([room(samples[0].tag), ALL]).emit('samples', samples);
      }
      this.metrics.wsSent(batches.length);
    } catch (err) {
      // Um erro aqui não pode interromper a assinatura do fluxo.
      this.logger.error(`Falha ao transmitir amostras: ${errorMessage(err)}`);
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
