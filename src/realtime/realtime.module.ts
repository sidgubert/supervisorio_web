import { Module } from '@nestjs/common';
import { IngestionModule } from '../ingestion/ingestion.module';
import { LiveGateway } from './live.gateway';

@Module({
  imports: [IngestionModule],
  providers: [LiveGateway],
})
export class RealtimeModule {}
