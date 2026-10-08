import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { Env, validateEnv } from './config/env.validation';
import { buildDataSourceOptions } from './database/typeorm.config';
import { IngestionModule } from './ingestion/ingestion.module';
import { MeasurementsModule } from './measurements/measurements.module';
import { SimulatorModule } from './simulator/simulator.module';
import { TagsModule } from './tags/tags.module';

@Module({
  controllers: [AppController],
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        ...buildDataSourceOptions({
          DB_HOST: config.get('DB_HOST', { infer: true }),
          DB_PORT: config.get('DB_PORT', { infer: true }),
          DB_USER: config.get('DB_USER', { infer: true }),
          DB_PASSWORD: config.get('DB_PASSWORD', { infer: true }),
          DB_NAME: config.get('DB_NAME', { infer: true }),
        }),
        // Aplica as migrations pendentes na subida, antes de a API e o
        // simulador começarem a usar o banco.
        migrationsRun: config.get('DB_MIGRATIONS_RUN', { infer: true }),
      }),
    }),
    MeasurementsModule,
    TagsModule,
    IngestionModule,
    SimulatorModule,
  ],
})
export class AppModule {}
