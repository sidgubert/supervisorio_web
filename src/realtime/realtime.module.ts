import { Module } from '@nestjs/common';
import { AlarmsModule } from '../alarms/alarms.module';
import { IngestionModule } from '../ingestion/ingestion.module';
import { LiveGateway } from './live.gateway';

@Module({
  imports: [IngestionModule, AlarmsModule],
  providers: [LiveGateway],
})
export class RealtimeModule {}
