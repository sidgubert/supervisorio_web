import { Module } from '@nestjs/common';
import { IngestionModule } from '../../ingestion/ingestion.module';
import { TagsModule } from '../../tags/tags.module';
import { MqttSource } from './mqtt.source';

@Module({
  imports: [IngestionModule, TagsModule],
  providers: [MqttSource],
})
export class MqttModule {}
