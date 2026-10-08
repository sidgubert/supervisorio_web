/** Qualidade "Good" (convenção OPC DA, usada como padrão do sistema). */
export const QUALITY_GOOD = 192;

/**
 * Amostra como uma fonte de aquisição a entrega ao núcleo de ingestão.
 *
 * Cada protocolo (sim, MQTT, Modbus, OPC UA) converte seu payload para este
 * formato; o resto (qualidade padrão, origem, validação) é responsabilidade
 * do IngestionService, para não ser reimplementado em cada fonte.
 */
export interface SampleInput {
  time: Date;
  /** Nome da tag, ex: "TIC-101.PV" */
  tag: string;
  value: number;
  /** Omitida = QUALITY_GOOD */
  quality?: number;
}

/** Amostra normalizada, pronta para persistência (uma linha de `measurements`). */
export interface Sample {
  time: Date;
  tag: string;
  value: number;
  quality: number;
  /** Nome da fonte que gerou a amostra: sim | mqtt | modbus | opcua */
  source: string;
}
