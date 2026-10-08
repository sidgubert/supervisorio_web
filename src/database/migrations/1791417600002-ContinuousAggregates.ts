import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Continuous aggregates do TimescaleDB: médias/mín/máx por minuto e por hora,
 * mantidos incrementalmente pelo banco. Gráficos de períodos longos leem
 * estas views em vez de varrer milhões de amostras brutas.
 *
 * - materialized_only = false ("real-time aggregate"): a consulta junta o que
 *   já foi materializado com o trecho mais recente, calculado na hora; o
 *   gráfico nunca fica defasado em relação ao bruto.
 * - start_offset generoso (1 dia / 7 dias): amostras que chegam atrasadas
 *   (ex: buffer de ingestão regravando após uma queda do banco de horas) ainda
 *   caem na janela que o job reprocessa.
 *
 * Sem transação: CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous) e
 * CALL refresh_continuous_aggregate não podem rodar dentro de uma.
 */
export class ContinuousAggregates1791417600002 implements MigrationInterface {
  name = 'ContinuousAggregates1791417600002';
  transaction = false;

  async up(q: QueryRunner): Promise<void> {
    for (const { view, bucket, startOffset, endOffset, schedule } of AGGREGATES) {
      await q.query(`
        CREATE MATERIALIZED VIEW IF NOT EXISTS ${view}
        WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
        SELECT time_bucket(INTERVAL '${bucket}', time) AS bucket,
               tag,
               avg(value)  AS avg,
               min(value)  AS min,
               max(value)  AS max,
               count(*)    AS count
        FROM measurements
        GROUP BY bucket, tag
        WITH NO DATA
      `);

      await q.query(`
        SELECT add_continuous_aggregate_policy('${view}',
          start_offset      => INTERVAL '${startOffset}',
          end_offset        => INTERVAL '${endOffset}',
          schedule_interval => INTERVAL '${schedule}',
          if_not_exists     => TRUE)
      `);

      // Materializa o histórico já existente (a política só cobre a janela
      // recente); em banco novo, é instantâneo.
      await q.query(`CALL refresh_continuous_aggregate('${view}', NULL, NULL)`);
    }
  }

  async down(q: QueryRunner): Promise<void> {
    // Remover a view remove também a política associada.
    for (const { view } of [...AGGREGATES].reverse()) {
      await q.query(`DROP MATERIALIZED VIEW IF EXISTS ${view}`);
    }
  }
}

const AGGREGATES = [
  {
    view: 'measurements_1m',
    bucket: '1 minute',
    startOffset: '1 day',
    endOffset: '1 minute',
    schedule: '1 minute',
  },
  {
    view: 'measurements_1h',
    bucket: '1 hour',
    startOffset: '7 days',
    endOffset: '1 hour',
    schedule: '30 minutes',
  },
];
