import { Module } from '@nestjs/common';
import { AlarmsModule } from '../alarms/alarms.module';
import { IngestionModule } from '../ingestion/ingestion.module';
import { MetricsModule } from '../metrics/metrics.module';
import { TagsModule } from '../tags/tags.module';
import { LiveFeedService } from './live-feed.service';
import { LiveGateway } from './live.gateway';

@Module({
  imports: [IngestionModule, AlarmsModule, MetricsModule, TagsModule],
  providers: [LiveFeedService, LiveGateway],
  exports: [LiveFeedService],
})
export class RealtimeModule {}
