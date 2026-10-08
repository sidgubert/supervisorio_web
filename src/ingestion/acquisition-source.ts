import { SampleInput } from './sample';

/** Callback pelo qual uma fonte entrega amostras ao núcleo de ingestão. */
export type EmitFn = (samples: SampleInput[]) => void;

/**
 * Contrato de uma fonte de aquisição de dados (simulador, MQTT, Modbus, OPC UA).
 *
 * A fonte só sabe adquirir e converter para SampleInput; não conhece buffer
 * nem banco. Para participar, ela se registra no IngestionService (em geral no
 * seu onModuleInit), que a inicia na subida e a para no encerramento.
 */
export interface AcquisitionSource {
  /** Identificador único da fonte, gravado em `measurements.source`. */
  readonly name: string;
  /** Começa a adquirir e a entregar amostras por `emit`. */
  start(emit: EmitFn): void | Promise<void>;
  /** Para de adquirir. Depois disso, não deve mais chamar `emit`. */
  stop(): void | Promise<void>;
}
