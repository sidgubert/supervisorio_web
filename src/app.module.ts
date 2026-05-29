import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { Measurement } from './measurements/measurement.entity';
import { MeasurementsModule } from './measurements/measurements.module';
import { SimulatorModule } from './simulator/simulator.module';

@Module({
  controllers: [AppController],
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get('DB_HOST', 'localhost'),
        port: Number(config.get('DB_PORT', 5432)),
        username: config.get('DB_USER', 'scada'),
        password: config.get('DB_PASSWORD', 'scada'),
        database: config.get('DB_NAME', 'scada'),
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
