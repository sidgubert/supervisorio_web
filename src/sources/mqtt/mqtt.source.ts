import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { connect, MqttClient } from 'mqtt';
import { Subscription } from 'rxjs';
import { errorMessage } from '../../common/error-message';
import { RateLimitedLogger } from '../../common/rate-limited-logger';
import { Env } from '../../config/env.validation';
import { AcquisitionSource, EmitFn, SourceHealth } from '../../ingestion/acquisition-source';
import { IngestionService } from '../../ingestion/ingestion.service';
import { TagChange, TagsService } from '../../tags/tags.service';
import { parseMqttPayload, validateMqttTopic } from './mqtt-payload';

/**
 * Fonte MQTT: assina o tópico de cada tag com `source = mqtt` (o `address`
 * da tag) e converte cada mensagem numa amostra (formatos em mqtt-payload.ts).
 *
 * - Não espera o broker na subida: conecta e reconecta em segundo plano.
 * - Reassina os tópicos a cada reconexão (sessão limpa).
 * - Acompanha o cadastro de tags: criar, alterar ou remover uma tag MQTT
 *   assina/desassina o tópico na hora, sem reiniciar a API.
 * - QoS 1: o broker reentrega mensagens não confirmadas; se uma reentrega
 *   duplicar uma amostra com `time`, o índice único (tag, time) a descarta.
 */
@Injectable()
export class MqttSource implements AcquisitionSource, OnModuleInit {
  readonly name = 'mqtt';
  private readonly logger = new Logger(MqttSource.name);
  private readonly rateLimited = new RateLimitedLogger(this.logger);
  private client?: MqttClient;
  private emit?: EmitFn;
  /** tópico -> nome da tag */
  private topics = new Map<string, string>();
  private changes?: Subscription;
  /** Recarregamentos do cadastro em série, na ordem das alterações. */
  private reloading: Promise<void> = Promise.resolve();
  private wasConnected = false;
  private reconnectMs = 2000;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly ingestion: IngestionService,
    private readonly tags: TagsService,
  ) {}

  onModuleInit() {
    // O validador vale mesmo com a fonte desligada: o cadastro continua
    // recusando tópicos inválidos.
    this.tags.registerAddressValidator(this.name, validateMqttTopic);
    if (!this.config.get('MQTT_ENABLED', { infer: true })) {
      this.logger.log('Fonte MQTT desabilitada (MQTT_ENABLED=false).');
      return;
    }
    this.ingestion.register(this);
  }

  async start(emit: EmitFn) {
    this.emit = emit;
    await this.reloadTags();
    this.changes = this.tags.changes$.subscribe((change) => {
      if (this.concerns(change)) this.scheduleReload();
    });

    const url = this.config.get('MQTT_URL', { infer: true });
    const username = this.config.get('MQTT_USERNAME', { infer: true }) || undefined;
    const password = this.config.get('MQTT_PASSWORD', { infer: true }) || undefined;
    const client = connect(url, {
      clientId: `scada-edu-${randomBytes(4).toString('hex')}`,
      username,
      password,
      clean: true,
      resubscribe: false, // as assinaturas são refeitas em 'connect', a partir do cadastro
      reconnectPeriod: this.reconnectMs,
      connectTimeout: 5000,
    });
    this.client = client;

    client.on('connect', () => {
      this.wasConnected = true;
      this.rateLimited.reset('conn');
      this.logger.log(`Conectado a ${url} (${this.topics.size} tópico(s)).`);
      this.subscribe([...this.topics.keys()]);
    });
    client.on('close', () => {
      if (this.wasConnected) this.logger.warn(`Conexão com ${url} perdida; reconectando...`);
      this.wasConnected = false;
    });
    client.on('error', (err) => {
      this.rateLimited.error('conn', `Erro no broker ${url}: ${errorMessage(err)}`);
    });
    client.on('message', (topic, payload) => this.onMessage(topic, payload));
  }

  async stop() {
    this.changes?.unsubscribe();
    await this.reloading;
    await this.client?.endAsync();
    this.client = undefined;
    this.emit = undefined;
  }

  status(): SourceHealth {
    return {
      connected: this.client?.connected ?? false,
      tags: this.topics.size,
      detail: this.config.get('MQTT_URL', { infer: true }),
    };
  }

  private onMessage(topic: string, payload: Buffer) {
    const tag = this.topics.get(topic);
    if (!tag || !this.emit) return;
    const parsed = parseMqttPayload(payload.toString('utf8'));
    if ('error' in parsed) {
      this.rateLimited.warn(
        `payload:${topic}`,
        `Payload inválido em "${topic}" (${tag}): ${parsed.error}`,
      );
      return;
    }
    this.emit([{ tag, ...parsed }]);
  }

  /** A alteração envolve uma tag MQTT (antes ou depois)? */
  private concerns(change: TagChange): boolean {
    return change.tag.source === this.name || change.previous?.source === this.name;
  }

  private scheduleReload() {
    this.reloading = this.reloading
      .then(() => this.reloadTags())
      .catch((err) => this.logger.error(`Falha ao recarregar as tags MQTT: ${errorMessage(err)}`));
  }

  /** Relê as tags MQTT do cadastro e ajusta as assinaturas pela diferença. */
  private async reloadTags() {
    const next = new Map<string, string>();
    for (const t of await this.tags.findEnabledBySource(this.name)) {
      const error = validateMqttTopic(t.address);
      if (error) {
        this.logger.warn(`Tag "${t.tag}" ignorada: ${error}.`);
        continue;
      }
      const topic = t.address!;
      const owner = next.get(topic);
      if (owner) {
        this.logger.warn(`Tag "${t.tag}" ignorada: o tópico "${topic}" já é da tag "${owner}".`);
        continue;
      }
      next.set(topic, t.tag);
    }

    const added = [...next.keys()].filter((topic) => !this.topics.has(topic));
    const removed = [...this.topics.keys()].filter((topic) => !next.has(topic));
    this.topics = next;
    if (this.client?.connected) {
      this.subscribe(added);
      this.unsubscribe(removed);
    }
  }

  private subscribe(topics: string[]) {
    if (topics.length === 0 || !this.client) return;
    this.client
      .subscribeAsync(topics, { qos: 1 })
      .then((granted) => {
        // QoS 128 = assinatura recusada pelo broker (ex: sem permissão).
        for (const g of granted.filter((g) => g.qos === 128)) {
          this.logger.error(`O broker recusou a assinatura de "${g.topic}".`);
        }
      })
      .catch((err) => this.logger.error(`Falha ao assinar tópicos: ${errorMessage(err)}`));
  }

  private unsubscribe(topics: string[]) {
    if (topics.length === 0 || !this.client) return;
    this.client
      .unsubscribeAsync(topics)
      .catch((err) => this.logger.error(`Falha ao cancelar assinaturas: ${errorMessage(err)}`));
  }
}
