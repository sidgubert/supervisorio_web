import { BadRequestException, Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { toCsv } from './csv';
import { MetricsCollectorService } from './metrics-collector.service';
import { PROTOCOL_PROFILES } from './protocol-profiles';
import { RetentionService } from './retention.service';
import { StorageStatsService } from './storage-stats.service';

/** Maior janela da exportação: 7 dias. */
const MAX_EXPORT_MINUTES = 7 * 24 * 60;

@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly collector: MetricsCollectorService,
    private readonly storage: StorageStatsService,
    private readonly retention: RetentionService,
  ) {}

  /** Ingestão (taxas, latência, clientes do tempo real) e retenção. */
  @Get('overview')
  overview() {
    return {
      ingest: this.collector.snapshot(),
      retention: { enabled: this.retention.isEnabled(), days: this.retention.getDays() },
    };
  }

  /** Tamanho, compressão, intervalo de dados e política de retenção. */
  @Get('storage')
  getStorage() {
    return this.storage.getStats();
  }

  /** Perfis educacionais dos protocolos, com as métricas ao vivo de cada um. */
  @Get('protocols')
  protocols() {
    const live = this.collector.snapshot().bySource;
    return {
      profiles: PROTOCOL_PROFILES.map((p) => ({ ...p, metrics: live[p.id] ?? null })),
    };
  }

  /**
   * Resumo por fonte e tag (amostras, primeira/última, média, mín., máx.) nos
   * últimos ?minutes= (padrão 60, até 7 dias), em ?format=json (padrão) ou csv.
   */
  @Get('export')
  async export(
    @Res({ passthrough: true }) res: Response,
    @Query('minutes') minutes?: string,
    @Query('format') format?: string,
  ) {
    const m = minutes === undefined ? 60 : Number(minutes);
    if (!Number.isInteger(m) || m < 1 || m > MAX_EXPORT_MINUTES) {
      throw new BadRequestException(`minutes deve estar entre 1 e ${MAX_EXPORT_MINUTES}`);
    }
    const fmt = format ?? 'json';
    if (fmt !== 'json' && fmt !== 'csv') {
      throw new BadRequestException('format deve ser json ou csv');
    }

    const rows = await this.storage.exportSummary(m);
    if (fmt === 'json') return { minutes: m, rows };

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="talos-resumo-${m}min.csv"`);
    // BOM: o Excel reconhece o UTF-8 (acentos) ao abrir o arquivo.
    return '\uFEFF' + toCsv(rows as unknown as Record<string, unknown>[]);
  }
}
