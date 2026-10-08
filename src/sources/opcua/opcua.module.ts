import { Module } from '@nestjs/common';
import { IngestionModule } from '../../ingestion/ingestion.module';
import { TagsModule } from '../../tags/tags.module';
import { OpcUaSource } from './opcua.source';

@Module({
  imports: [IngestionModule, TagsModule],
  providers: [OpcUaSource],
})
export class OpcUaModule {}
