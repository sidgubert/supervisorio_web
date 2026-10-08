import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Sample } from '../ingestion/sample';
import { Bucket, HistoryQuery } from './history-query';
import { Measurement } from './measurement.entity';

/**
 * Inserção em lote com uma única instrução: as colunas vão como arrays e o
 * unnest() as transforma em linhas. São sempre 6 parâmetros, qualquer que seja
 * o tamanho do lote (um INSERT ... VALUES tem limite de 65.535 parâmetros).
 *
 * ON CONFLICT DO NOTHING + índice único (tag, time): regravar um lote que o
 * banco já tinha aceitado não duplica amostras. O CTE conta as inseridas.
 */
const INSERT_SQL = `
  WITH inserted AS (
    INSERT INTO measurements (time, tag, value, quality, source, received_at)
    SELECT * FROM unnest(
      $1::timestamptz[], $2::text[], $3::float8[], $4::int2[], $5::text[], $6::timestamptz[]
    )
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::int AS inserted FROM inserted`;

/** Última amostra de uma tag (GET /api/dashboard/tags). */
export interface LatestSample {
  tag: string;
  time: Date;
  value: number;
  quality: number;
  source: string | null;
}

/** Ponto de uma série histórica; no bruto, avg = min = max = valor e count = 1. */
export interface HistoryPoint {
  time: Date;
  avg: number;
  min: number;
  max: number;
  count: number;
}

/** Consulta por resolução. Os nomes de view vêm desta tabela fixa, nunca do usuário. */
const HISTORY_SQL: Record<Bucket, string> = {
  raw: `
    SELECT time, value AS avg, value AS min, value AS max, 1 AS count
    FROM measurements
    WHERE tag = $1 AND time >= $2 AND time < $3
    ORDER BY time`,
  '1m': `
    SELECT bucket AS time, avg, min, max, count::int AS count
    FROM measurements_1m
    WHERE tag = $1 AND bucket >= $2 AND bucket < $3
    ORDER BY bucket`,
  '1h': `
    SELECT bucket AS time, avg, min, max, count::int AS count
    FROM measurements_1h
    WHERE tag = $1 AND bucket >= $2 AND bucket < $3
    ORDER BY bucket`,
};

@Injectable()
export class MeasurementsService {
  constructor(
    @InjectRepository(Measurement)
    private readonly repo: Repository<Measurement>,
  ) {}

  /**
   * Grava um lote de amostras e devolve quantas foram de fato inseridas
   * (amostras com (tag, time) já existentes são ignoradas). Uma instrução só:
   * ou grava o lote inteiro, ou nada.
   */
  async insertBatch(rows: Sample[]): Promise<number> {
    if (rows.length === 0) return 0;
    const result: { inserted: number }[] = await this.repo.query(INSERT_SQL, [
      rows.map((r) => r.time),
      rows.map((r) => r.tag),
      rows.map((r) => r.value),
      rows.map((r) => r.quality),
      rows.map((r) => r.source),
      rows.map((r) => r.receivedAt),
    ]);
    return result[0].inserted;
  }

  /**
   * Série histórica de uma tag no período, na resolução pedida. As resoluções
   * 1m e 1h vêm dos continuous aggregates (migration ContinuousAggregates).
   */
  history(tag: string, q: HistoryQuery): Promise<HistoryPoint[]> {
    return this.repo.query(HISTORY_SQL[q.bucket], [tag, q.from, q.to]);
  }

  /**
   * Última amostra de cada tag cadastrada. O LATERAL busca uma tag por vez
   * pelo índice (tag, time DESC): rápido com qualquer volume, ao contrário de
   * um DISTINCT ON sobre a hypertable inteira.
   */
  latestPerTag(): Promise<LatestSample[]> {
    return this.repo.query(`
      SELECT t.tag, m.time, m.value, m.quality, m.source
      FROM tags t
      CROSS JOIN LATERAL (
        SELECT time, value, quality, source
        FROM measurements
        WHERE tag = t.tag
        ORDER BY time DESC
        LIMIT 1
      ) m
      ORDER BY t.tag`);
  }

  /** Últimas N amostras de uma tag. */
  async latest(tag: string, limit = 100): Promise<Measurement[]> {
    return this.repo.find({
      where: { tag },
      order: { time: 'DESC' },
      take: limit,
    });
  }
}
