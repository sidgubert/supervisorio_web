import { Controller, Get } from '@nestjs/common';
import { IngestionService } from './ingestion.service';

@Controller('sources')
export class SourcesController {
  constructor(private readonly ingestion: IngestionService) {}

  /** Fontes de aquisição registradas: conexão, tags, amostras, última amostra. */
  @Get()
  status() {
    return this.ingestion.status();
  }
}
