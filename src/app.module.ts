import { Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { DatabaseExceptionFilter } from './common/database-exception.filter';
import { Env, validateEnv } from './config/env.validation';
import { buildDataSourceOptions } from './database/typeorm.config';
import { IngestionModule } from './ingestion/ingestion.module';
import { MeasurementsModule } from './measurements/measurements.module';
import { RealtimeModule } from './realtime/realtime.module';
import { ModbusModule } from './sources/modbus/modbus.module';
import { MqttModule } from './sources/mqtt/mqtt.module';
import { OpcUaModule } from './sources/opcua/opcua.module';
import { SimulatorModule } from './sources/simulator/simulator.module';
import { TagsModule } from './tags/tags.module';

@Module({
  controllers: [AppController],
  providers: [
    // Valida os corpos (DTOs com class-validator); campos desconhecidos -> 400.
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    },
    { provide: APP_FILTER, useClass: DatabaseExceptionFilter },
  ],
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
    RealtimeModule,
    SimulatorModule,
    MqttModule,
    ModbusModule,
    OpcUaModule,
  ],
})
export class AppModule {}
