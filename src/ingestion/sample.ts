/**
 * Qualidade no estilo OPC DA (byte de qualidade), usada como modelo interno do
 * sistema. Cada fonte converte a qualidade do seu protocolo para esta escala
 * (ex: o StatusCode do OPC UA, em OpcUaSource).
 */
export const QUALITY_GOOD = 192; // 0xC0
export const QUALITY_UNCERTAIN = 64; // 0x40
export const QUALITY_BAD = 0;

/**
 * Amostra como uma fonte de aquisição a entrega ao núcleo de ingestão.
 *
 * Cada protocolo (sim, MQTT, Modbus, OPC UA) converte seu payload para este
 * formato; o resto (qualidade padrão, origem, carimbo de recebimento,
 * validação) é responsabilidade do IngestionService, para não ser
 * reimplementado em cada fonte.
 */
export interface SampleInput {
  /** Instante da medição segundo a fonte. Omitido = instante de recebimento. */
  time?: Date;
  /** Nome da tag, ex: "TIC-101.PV" */
  tag: string;
  value: number;
  /** Byte de qualidade (0–255). Omitida = QUALITY_GOOD */
  quality?: number;
}

/** Amostra normalizada, pronta para persistência (uma linha de `measurements`). */
export interface Sample {
  /** Instante da medição (da fonte, ou o de recebimento se ela não informar). */
  time: Date;
  tag: string;
  value: number;
  quality: number;
  /** Nome da fonte que gerou a amostra: sim | mqtt | modbus | opcua */
  source: string;
  /** Instante em que o servidor recebeu a amostra. */
  receivedAt: Date;
}
