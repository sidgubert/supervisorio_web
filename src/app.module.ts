import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { Env, validateEnv } from './config/env.validation';
import { Measurement } from './measurements/measurement.entity';
import { MeasurementsModule } from './measurements/measurements.module';
import { SimulatorModule } from './simulator/simulator.module';

@Module({
  controllers: [AppController],
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        type: 'postgres',
        host: config.get('DB_HOST', { infer: true }),
        port: config.get('DB_PORT', { infer: true }),
        username: config.get('DB_USER', { infer: true }),
        password: config.get('DB_PASSWORD', { infer: true }),
        database: config.get('DB_NAME', { infer: true }),
        entities: [Measurement],
        // false: o schema (hypertable) é criado pelo db/init.sql,
        // não pelo TypeORM, que não sabe criar hypertables.
        synchronize: false,
      }),
    }),
    MeasurementsModule,
    SimulatorModule,
  ],
})
export class AppModule {}
