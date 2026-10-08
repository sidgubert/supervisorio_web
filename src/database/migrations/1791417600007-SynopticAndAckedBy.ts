import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Dashboard (Fases 3–4):
 *
 * - tags.synoptic_kind/x/y: como e onde a tag aparece no sinótico (desenho do
 *   processo). x/y em % da área do desenho; kind nulo = fora do sinótico.
 * - alarms.acked_by: quem reconheceu o alarme (usuário autenticado).
 *
 * As tags do simulador ganham uma posição no sinótico.
 */
export class SynopticAndAckedBy1791417600007 implements MigrationInterface {
  name = 'SynopticAndAckedBy1791417600007';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE tags
        ADD COLUMN synoptic_kind TEXT
          CONSTRAINT chk_tags_synoptic_kind
          CHECK (synoptic_kind IN ('tank', 'pressure', 'flow', 'level', 'sensor')),
        ADD COLUMN synoptic_x SMALLINT CONSTRAINT chk_tags_synoptic_x CHECK (synoptic_x BETWEEN 0 AND 100),
        ADD COLUMN synoptic_y SMALLINT CONSTRAINT chk_tags_synoptic_y CHECK (synoptic_y BETWEEN 0 AND 100)
    `);
    await q.query(`
      UPDATE tags AS t SET synoptic_kind = v.kind, synoptic_x = v.x, synoptic_y = v.y
      FROM (VALUES
        ('TIC-101.PV', 'tank', 20, 35),
        ('PIC-201.PV', 'pressure', 75, 35),
        ('FIC-301.PV', 'flow', 50, 20),
        ('LIC-401.PV', 'level', 50, 70)
      ) AS v(tag, kind, x, y)
      WHERE t.tag = v.tag AND t.synoptic_kind IS NULL
    `);
    await q.query(`ALTER TABLE alarms ADD COLUMN acked_by TEXT`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE alarms DROP COLUMN IF EXISTS acked_by`);
    await q.query(`
      ALTER TABLE tags
        DROP COLUMN IF EXISTS synoptic_kind,
        DROP COLUMN IF EXISTS synoptic_x,
        DROP COLUMN IF EXISTS synoptic_y
    `);
  }
}
