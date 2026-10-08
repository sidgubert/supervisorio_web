import { Module } from '@nestjs/common';
import { AlarmsModule } from '../alarms/alarms.module';
import { MeasurementsModule } from '../measurements/measurements.module';
import { MetricsModule } from '../metrics/metrics.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { TagsModule } from '../tags/tags.module';
import { DashboardController } from './dashboard.controller';

@Module({
  imports: [MeasurementsModule, AlarmsModule, TagsModule, RealtimeModule, MetricsModule],
  controllers: [DashboardController],
})
export class DashboardModule {}
