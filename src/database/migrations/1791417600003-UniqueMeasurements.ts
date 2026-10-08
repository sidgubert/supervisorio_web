import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Torna a gravação idempotente: no máximo uma amostra por (tag, time).
 *
 * Por quê: se a conexão cai depois de o banco confirmar o INSERT mas antes de
 * a resposta chegar à API ("Connection terminated unexpectedly"), o buffer de
 * ingestão regrava o lote. Com o índice único e INSERT ... ON CONFLICT DO
 * NOTHING (MeasurementsService.insertBatch), a regravação não duplica nada.
 *
 * O índice único substitui o antigo idx_measurements_tag_time, com as mesmas
 * colunas e ordem: as consultas por tag e período continuam usando-o.
 */
export class UniqueMeasurements1791417600003 implements MigrationInterface {
  name = 'UniqueMeasurements1791417600003';

  async up(q: QueryRunner): Promise<void> {
    // Remove duplicatas que já existam (mantém uma de cada). Linhas com o
    // mesmo `time` estão sempre no mesmo chunk, então comparar ctid é válido.
    await q.query(`
      DELETE FROM measurements a
      USING measurements b
      WHERE a.tag = b.tag AND a.time = b.time AND a.ctid < b.ctid
    `);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_measurements_tag_time
        ON measurements (tag, time DESC)
    `);
    await q.query(`DROP INDEX IF EXISTS idx_measurements_tag_time`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_measurements_tag_time
        ON measurements (tag, time DESC)
    `);
    await q.query(`DROP INDEX IF EXISTS uq_measurements_tag_time`);
  }
}
