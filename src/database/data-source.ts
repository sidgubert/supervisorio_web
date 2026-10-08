/**
 * DataSource usado só pelo CLI do TypeORM (npm run migration:*).
 * A API não importa este arquivo; ela monta a conexão no AppModule.
 */
import 'dotenv/config';
import { DataSource } from 'typeorm';
import { validateEnv } from '../config/env.validation';
import { buildDataSourceOptions } from './typeorm.config';

export default new DataSource(buildDataSourceOptions(validateEnv(process.env)));
