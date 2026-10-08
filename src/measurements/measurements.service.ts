import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Bucket, HistoryQuery } from './history-query';
import { Measurement } from './measurement.entity';

/**
 * Linhas por INSERT. O PostgreSQL aceita no máximo 65.535 parâmetros por
 * comando; com 5 colunas, 1000 linhas = 5000 parâmetros, bem abaixo do limite.
 */
const INSERT_CHUNK_SIZE = 1000;

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
   * Inserção em lote. Em séries temporais é muito mais eficiente
   * gravar N amostras de uma vez do que uma a uma.
   *
   * Lotes grandes são divididos em blocos de INSERT_CHUNK_SIZE dentro de
   * uma única transação: ou grava tudo, ou nada (evita duplicatas quando
   * quem chamou tenta de novo após uma falha).
   */
  async insertBatch(rows: Partial<Measurement>[]): Promise<number> {
    if (rows.length === 0) return 0;
    await this.repo.manager.transaction(async (em) => {
      for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
        await em.insert(Measurement, rows.slice(i, i + INSERT_CHUNK_SIZE));
      }
    });
    return rows.length;
  }

  /**
   * Série histórica de uma tag no período, na resolução pedida. As resoluções
   * 1m e 1h vêm dos continuous aggregates (migration ContinuousAggregates).
   */
  history(tag: string, q: HistoryQuery): Promise<HistoryPoint[]> {
    return this.repo.query(HISTORY_SQL[q.bucket], [tag, q.from, q.to]);
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
