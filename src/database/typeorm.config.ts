import { join } from 'path';
import { DataSourceOptions } from 'typeorm';
import { Env } from '../config/env.validation';
import { Measurement } from '../measurements/measurement.entity';
import { Tag } from '../tags/tag.entity';

/** Variáveis de ambiente necessárias para conectar ao banco. */
export type DbEnv = Pick<Env, 'DB_HOST' | 'DB_PORT' | 'DB_USER' | 'DB_PASSWORD' | 'DB_NAME'>;

/**
 * Opções do TypeORM, compartilhadas pela API (AppModule) e pelo CLI de
 * migrations (data-source.ts), para os dois sempre apontarem para o mesmo
 * banco com as mesmas entidades e migrations.
 */
export function buildDataSourceOptions(env: DbEnv): DataSourceOptions {
  return {
    type: 'postgres',
    host: env.DB_HOST,
    port: env.DB_PORT,
    username: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    entities: [Measurement, Tag],
    // .ts no CLI (ts-node), .js na API compilada (dist/).
    migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
    migrationsTableName: 'migrations',
    // O schema é versionado pelas migrations, nunca gerado pelo TypeORM
    // (que, entre outras coisas, não sabe criar hypertables).
    synchronize: false,
  };
}
