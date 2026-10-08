import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface StorageStats {
  /** Linhas de measurements (aproximado acima de 100 mil: contar tudo seria lento). */
  measurementsRows: number;
  measurementsRowsApproximate: boolean;
  /** Tamanho total da hypertable (dados + índices), ex: "12 MB". */
  hypertableSize: string;
  compression: {
    compressedChunks: number;
    totalChunks: number;
    /** Antes e depois da compressão, nos chunks comprimidos. */
    beforeSize: string | null;
    afterSize: string | null;
    /** Redução em % (null se nada comprimido ainda). */
    savingsPct: number | null;
  };
  alarmRows: number;
  oldestMeasurement: string | null;
  newestMeasurement: string | null;
  /** Amostras e tags por fonte nas últimas 24 h. */
  bySourceLast24h: { source: string; count: number; tags: number }[];
  retentionPolicy: { enabled: boolean; dropAfter: string | null };
}

export interface ExportRow {
  source: string | null;
  tag: string;
  samples: number;
  first_seen: Date;
  last_seen: Date;
  avg_value: number;
  min_value: number;
  max_value: number;
}

/** Abaixo disso, conta exato; acima, usa a estimativa do TimescaleDB. */
const EXACT_COUNT_LIMIT = 100_000;

/** Estatísticas de armazenamento do TimescaleDB (Fase 5). */
@Injectable()
export class StorageStatsService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async getStats(): Promise<StorageStats> {
    const [{ approx }] = await this.ds.query<{ approx: string }[]>(
      `SELECT approximate_row_count('measurements') AS approx`,
    );
    let rows = Number(approx);
    const approximate = rows >= EXACT_COUNT_LIMIT;
    if (!approximate) {
      const [{ n }] = await this.ds.query<{ n: string }[]>(
        `SELECT count(*) AS n FROM measurements`,
      );
      rows = Number(n);
    }

    const [{ size }] = await this.ds.query<{ size: string }[]>(
      `SELECT pg_size_pretty(hypertable_size('measurements')) AS size`,
    );
    const [c] = await this.ds.query<
      {
        compressed: string | null;
        total: string | null;
        before: string | null;
        after: string | null;
      }[]
    >(`
      SELECT number_compressed_chunks AS compressed, total_chunks AS total,
             before_compression_total_bytes AS before, after_compression_total_bytes AS after
      FROM hypertable_compression_stats('measurements')`);
    const before = c?.before ? Number(c.before) : null;
    const after = c?.after ? Number(c.after) : null;

    const [range] = await this.ds.query<{ oldest: Date | null; newest: Date | null }[]>(
      `SELECT min(time) AS oldest, max(time) AS newest FROM measurements`,
    );
    const [{ alarms }] = await this.ds.query<{ alarms: string }[]>(
      `SELECT count(*) AS alarms FROM alarms`,
    );
    const bySource = await this.ds.query<{ source: string; count: string; tags: number }[]>(`
      SELECT coalesce(source, '?') AS source, count(*) AS count, count(DISTINCT tag)::int AS tags
      FROM measurements
      WHERE time > now() - interval '1 day'
      GROUP BY 1
      ORDER BY 2 DESC`);
    const [policy] = await this.ds.query<{ drop_after: string }[]>(`
      SELECT config->>'drop_after' AS drop_after
      FROM timescaledb_information.jobs
      WHERE proc_name = 'policy_retention' AND hypertable_name = 'measurements'
      LIMIT 1`);

    return {
      measurementsRows: rows,
      measurementsRowsApproximate: approximate,
      hypertableSize: size,
      compression: {
        compressedChunks: Number(c?.compressed ?? 0),
        totalChunks: Number(c?.total ?? 0),
        beforeSize: before === null ? null : prettyBytes(before),
        afterSize: after === null ? null : prettyBytes(after),
        savingsPct: before && after !== null ? Math.round((1 - after / before) * 1000) / 10 : null,
      },
      alarmRows: Number(alarms),
      oldestMeasurement: range?.oldest ? new Date(range.oldest).toISOString() : null,
      newestMeasurement: range?.newest ? new Date(range.newest).toISOString() : null,
      bySourceLast24h: bySource.map((r) => ({ ...r, count: Number(r.count) })),
      retentionPolicy: { enabled: !!policy, dropAfter: policy?.drop_after ?? null },
    };
  }

  /** Resumo por fonte e tag nos últimos `minutes` minutos (exportação). */
  exportSummary(minutes: number): Promise<ExportRow[]> {
    return this.ds.query(
      `
      SELECT source, tag, count(*)::int AS samples,
             min(time) AS first_seen, max(time) AS last_seen,
             round(avg(value)::numeric, 3)::float8 AS avg_value,
             min(value) AS min_value, max(value) AS max_value
      FROM measurements
      WHERE time >= now() - make_interval(mins => $1)
      GROUP BY source, tag
      ORDER BY source, tag`,
      [minutes],
    );
  }
}

function prettyBytes(n: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}
