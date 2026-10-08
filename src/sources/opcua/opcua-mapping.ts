/**
 * Conversões entre o OPC UA e o modelo interno de amostra, em funções puras
 * (sem carregar o node-opcua, que a fonte só importa quando habilitada).
 */
import { QUALITY_BAD, QUALITY_GOOD, QUALITY_UNCERTAIN } from '../../ingestion/sample';

/**
 * NodeId no formato texto do OPC UA (Part 6, 5.3.1.10), com namespace
 * opcional (padrão 0):
 *
 *   ns=3;s=SlowUInt1      string
 *   ns=2;i=1001           numérico
 *   i=2258                numérico no namespace 0
 *   ns=1;g=09087e75-8e5e-499b-954f-f2a9603db28a   GUID
 *   ns=1;b=M/RbKBsRVkePCePcx24oRA==               opaco (base64)
 */
const NODE_ID =
  /^(?:ns=(\d+);)?(?:i=(\d+)|s=(.+)|g=[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|b=[A-Za-z0-9+/]+={0,2})$/i;
const EXAMPLE = 'ex: ns=3;s=SlowUInt1, ns=2;i=1001';

/** Validador para o cadastro de tags: mensagem de erro, ou undefined se ok. */
export function validateNodeId(address: string | null | undefined): string | undefined {
  if (!address) return `informe o NodeId OPC UA (${EXAMPLE})`;
  const match = NODE_ID.exec(address);
  if (!match) return `NodeId inválido; formato ns=<n>;<i|s|g|b>=<id> (${EXAMPLE})`;
  const [, ns, numeric] = match;
  if (ns !== undefined && Number(ns) > 65535) return 'o namespace (ns) vai de 0 a 65535';
  if (numeric !== undefined && Number(numeric) > 0xffffffff) {
    return 'o identificador numérico (i) vai de 0 a 4294967295';
  }
  return undefined;
}

/**
 * StatusCode do OPC UA -> byte de qualidade interno. Os 2 bits mais altos do
 * StatusCode são a severidade: 00 Good, 01 Uncertain, 10/11 Bad.
 */
export function qualityFromStatusCode(statusCode: number): number {
  const severity = statusCode >>> 30;
  if (severity === 0) return QUALITY_GOOD;
  if (severity === 1) return QUALITY_UNCERTAIN;
  return QUALITY_BAD;
}

/** Ids dos tipos numéricos do OPC UA (Part 6, tabela 1). */
const DATA_TYPE = {
  Boolean: 1,
  SByte: 2,
  Byte: 3,
  Int16: 4,
  UInt16: 5,
  Int32: 6,
  UInt32: 7,
  Int64: 8,
  UInt64: 9,
  Float: 10,
  Double: 11,
} as const;

const SIMPLE_NUMERIC: readonly number[] = [
  DATA_TYPE.SByte,
  DATA_TYPE.Byte,
  DATA_TYPE.Int16,
  DATA_TYPE.UInt16,
  DATA_TYPE.Int32,
  DATA_TYPE.UInt32,
  DATA_TYPE.Float,
  DATA_TYPE.Double,
];

/** O que importa de um Variant do node-opcua. */
export interface VariantLike {
  dataType: number;
  /** 0 = escalar; 1 = array; 2 = matriz. */
  arrayType: number;
  value: unknown;
}

/**
 * Valor de um Variant como número, ou undefined se não for um escalar
 * numérico/booleano (string, data, array...): o histórico só guarda números.
 *
 * Int64/UInt64 vêm do node-opcua como [alto, baixo] (dois inteiros de 32
 * bits); acima de 2^53 a conversão perde precisão.
 */
export function variantToNumber(variant: VariantLike | null | undefined): number | undefined {
  if (!variant || variant.arrayType !== 0) return undefined;
  const { dataType, value } = variant;
  if (dataType === DATA_TYPE.Boolean) {
    return typeof value === 'boolean' ? (value ? 1 : 0) : undefined;
  }
  if (SIMPLE_NUMERIC.includes(dataType)) {
    if (typeof value !== 'number') return undefined;
    // Float tem ~7 dígitos significativos; além disso é artefato da conversão
    // para double (3.655 vira 3.6549999713897705).
    return dataType === DATA_TYPE.Float ? Number(value.toPrecision(7)) : value;
  }
  if (dataType === DATA_TYPE.Int64 || dataType === DATA_TYPE.UInt64) {
    if (Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number')) {
      const [high, low] = value as [number, number];
      return high * 0x100000000 + low;
    }
  }
  return undefined;
}

/** Tipos não numéricos mais comuns (Part 6, tabela 1), para os logs. */
const OTHER_TYPES: Record<number, string> = {
  12: 'String',
  13: 'DateTime',
  14: 'Guid',
  15: 'ByteString',
  16: 'XmlElement',
  17: 'NodeId',
  19: 'StatusCode',
  20: 'QualifiedName',
  21: 'LocalizedText',
  22: 'ExtensionObject',
};

/** Nome legível de um tipo (para logs). */
export function dataTypeName(dataType: number): string {
  const numeric = Object.entries(DATA_TYPE).find(([, id]) => id === dataType);
  return numeric?.[0] ?? OTHER_TYPES[dataType] ?? `DataType ${dataType}`;
}
