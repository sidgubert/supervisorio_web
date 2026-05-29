-- =============================================================
--  Inicialização do banco de séries temporais (TimescaleDB)
--  Executado automaticamente na primeira subida do container.
-- =============================================================

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Tabela única de medições. O modelo "narrow/long" (uma linha por
-- amostra de cada tag) é o padrão recomendado para séries temporais:
-- facilita adicionar novas tags sem alterar o schema.
CREATE TABLE IF NOT EXISTS measurements (
  time     TIMESTAMPTZ      NOT NULL,
  tag      TEXT             NOT NULL,            -- ex: "TIC-101.PV"
  value    DOUBLE PRECISION NOT NULL,
  quality  SMALLINT         NOT NULL DEFAULT 192, -- padrão OPC: 192 = Good
  source   TEXT                                  -- protocolo de origem: mqtt|modbus|opcua|sim
);

-- Converte a tabela comum em hypertable particionada por tempo.
-- É isso que dá ao TimescaleDB o desempenho de escrita/leitura em séries.
SELECT create_hypertable('measurements', 'time', if_not_exists => TRUE);

-- Índice para as consultas mais comuns do dashboard:
-- "valores da tag X nos últimos N minutos".
CREATE INDEX IF NOT EXISTS idx_measurements_tag_time
  ON measurements (tag, time DESC);

-- (Opcional) Política de retenção: descarta dados com mais de 90 dias.
-- Comente se quiser manter histórico completo para o TCC.
-- SELECT add_retention_policy('measurements', INTERVAL '90 days', if_not_exists => TRUE);
