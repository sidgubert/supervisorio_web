import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cadastro de tags: metadados de cada variável de processo (unidade, faixa de
 * engenharia, limites de alarme, onde ela é adquirida).
 *
 * Não há FK de measurements.tag para tags.tag de propósito: uma amostra de tag
 * não cadastrada faria o INSERT do lote inteiro falhar, e o buffer de ingestão
 * ficaria tentando regravar o mesmo lote para sempre.
 */
export class CreateTags1791417600001 implements MigrationInterface {
  name = 'CreateTags1791417600001';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE tags (
        tag          TEXT PRIMARY KEY,                 -- ex: "TIC-101.PV"
        description  TEXT,
        unit         TEXT,                             -- unidade de engenharia
        eng_min      DOUBLE PRECISION,                 -- faixa de engenharia
        eng_max      DOUBLE PRECISION,
        alarm_ll     DOUBLE PRECISION,                 -- muito baixo
        alarm_l      DOUBLE PRECISION,                 -- baixo
        alarm_h      DOUBLE PRECISION,                 -- alto
        alarm_hh     DOUBLE PRECISION,                 -- muito alto
        source       TEXT,                             -- sim|mqtt|modbus|opcua
        address      TEXT,                             -- tópico MQTT, registro Modbus, NodeId OPC UA
        enabled      BOOLEAN     NOT NULL DEFAULT TRUE,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT chk_tags_eng_range CHECK (eng_min < eng_max),
        CONSTRAINT chk_tags_alarm_order CHECK (
          (alarm_ll IS NULL OR alarm_l  IS NULL OR alarm_ll <= alarm_l) AND
          (alarm_l  IS NULL OR alarm_h  IS NULL OR alarm_l  <  alarm_h) AND
          (alarm_h  IS NULL OR alarm_hh IS NULL OR alarm_h  <= alarm_hh)
        )
      )
    `);

    // Tags do simulador (Fase 1), com limites que a senoide normalmente não
    // atinge: servem de exemplo para a futura lógica de alarmes.
    await q.query(`
      INSERT INTO tags
        (tag, description, unit, eng_min, eng_max, alarm_ll, alarm_l, alarm_h, alarm_hh, source)
      VALUES
        ('TIC-101.PV', 'Temperatura do reator',       '°C',   0, 150, 50,  60,  90,  100, 'sim'),
        ('PIC-201.PV', 'Pressão da linha de vapor',   'bar',  0,  10, 2.5, 3,   5.5, 6,   'sim'),
        ('FIC-301.PV', 'Vazão de alimentação',        'm³/h', 0, 250, 60,  80,  165, 185, 'sim'),
        ('LIC-401.PV', 'Nível do tanque de processo', '%',    0, 100, 10,  20,  85,  95,  'sim')
      ON CONFLICT (tag) DO NOTHING
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS tags`);
  }
}
