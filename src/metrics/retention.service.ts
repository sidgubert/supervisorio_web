import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { errorMessage } from '../common/error-message';
import { Env } from '../config/env.validation';

/**
 * Política de retenção do histórico bruto (Fase 5), com a função nativa do
 * TimescaleDB: chunks de `measurements` mais antigos que RETENTION_DAYS são
 * apagados por um job do próprio banco.
 *
 * A configuração do .env é a fonte da verdade: na subida, a política antiga é
 * removida e, se RETENTION_ENABLED=true, recriada com o prazo atual. Assim,
 * mudar o prazo ou desligar a retenção tem efeito ao reiniciar a API.
 *
 * Os agregados de 1 min e 1 h (continuous aggregates) não são apagados: o
 * histórico agregado continua disponível depois que o bruto expira.
 */
@Injectable()
export class RetentionService implements OnModuleInit {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly config: ConfigService<Env, true>,
    @InjectDataSource() private readonly ds: DataSource,
  ) {}

  isEnabled() {
    return this.config.get('RETENTION_ENABLED', { infer: true });
  }

  getDays() {
    return this.config.get('RETENTION_DAYS', { infer: true });
  }

  async onModuleInit() {
    try {
      await this.ds.query(`SELECT remove_retention_policy('measurements', if_exists => TRUE)`);
      if (!this.isEnabled()) {
        this.logger.log('Retenção desligada: o histórico bruto é mantido.');
        return;
      }
      // RETENTION_DAYS já foi validado como inteiro (env.validation.ts).
      await this.ds.query(
        `SELECT add_retention_policy('measurements', make_interval(days => $1))`,
        [this.getDays()],
      );
      this.logger.log(`Retenção ligada: amostras com mais de ${this.getDays()} dias são apagadas.`);
    } catch (err) {
      this.logger.error(`Falha ao configurar a retenção: ${errorMessage(err)}`);
    }
  }
}
