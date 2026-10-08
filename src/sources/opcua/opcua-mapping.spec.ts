import { QUALITY_BAD, QUALITY_GOOD, QUALITY_UNCERTAIN } from '../../ingestion/sample';
import {
  dataTypeName,
  qualityFromStatusCode,
  validateNodeId,
  variantToNumber,
} from './opcua-mapping';

describe('validateNodeId', () => {
  it.each([
    'ns=3;s=SlowUInt1',
    'ns=1;s=Planta.Área 1/TIC-101',
    'ns=2;i=1001',
    'i=2258',
    's=Temperatura',
    'ns=1;g=09087e75-8e5e-499b-954f-f2a9603db28a',
    'ns=1;b=M/RbKBsRVkePCePcx24oRA==',
    'ns=65535;i=4294967295',
  ])('aceita %j', (nodeId) => {
    expect(validateNodeId(nodeId)).toBeUndefined();
  });

  it.each([
    [null, /informe o NodeId/],
    ['', /informe o NodeId/],
    ['SlowUInt1', /NodeId inválido/],
    ['ns=3;x=1', /NodeId inválido/],
    ['ns=a;i=1', /NodeId inválido/],
    ['ns=3;i=abc', /NodeId inválido/],
    ['ns=3;s=', /NodeId inválido/],
    ['ns=1;g=nao-e-guid', /NodeId inválido/],
    ['ns=65536;i=1', /namespace/],
    ['i=4294967296', /identificador numérico/],
  ])('recusa %j', (nodeId, msg) => {
    expect(validateNodeId(nodeId)).toMatch(msg);
  });
});

describe('qualityFromStatusCode', () => {
  it.each([
    [0x00000000, QUALITY_GOOD], // Good
    [0x00a90000, QUALITY_GOOD], // GoodClamped
    [0x40000000, QUALITY_UNCERTAIN], // Uncertain
    [0x408f0000, QUALITY_UNCERTAIN], // UncertainLastUsableValue
    [0x80000000, QUALITY_BAD], // Bad
    [0x80340000, QUALITY_BAD], // BadNodeIdUnknown
    [0x808b0000, QUALITY_BAD], // BadSensorFailure
    [0xc0000000, QUALITY_BAD], // severidade 11 (reservada) também é Bad
  ])('0x%s -> %i', (code, quality) => {
    expect(qualityFromStatusCode(code)).toBe(quality);
  });
});

describe('variantToNumber', () => {
  const v = (dataType: number, value: unknown, arrayType = 0) => ({ dataType, arrayType, value });

  it('tipos numéricos simples', () => {
    expect(variantToNumber(v(11, 21.5))).toBe(21.5); // Double
    expect(variantToNumber(v(10, 1.25))).toBe(1.25); // Float
    expect(variantToNumber(v(10, Math.fround(3.655)))).toBe(3.655); // Float sem artefato
    expect(variantToNumber(v(11, 3.6549999713897705))).toBe(3.6549999713897705); // Double intacto
    expect(variantToNumber(v(6, -7))).toBe(-7); // Int32
    expect(variantToNumber(v(7, 4294967295))).toBe(4294967295); // UInt32
    expect(variantToNumber(v(3, 255))).toBe(255); // Byte
  });

  it('booleano vira 1/0', () => {
    expect(variantToNumber(v(1, true))).toBe(1);
    expect(variantToNumber(v(1, false))).toBe(0);
  });

  it('Int64/UInt64 no formato [alto, baixo] do node-opcua', () => {
    expect(variantToNumber(v(9, [1, 2]))).toBe(4294967298); // 2^32 + 2
    expect(variantToNumber(v(8, [-1, 4294967295]))).toBe(-1);
  });

  it('recusa o que não é escalar numérico', () => {
    expect(variantToNumber(v(12, 'texto'))).toBeUndefined(); // String
    expect(variantToNumber(v(13, new Date()))).toBeUndefined(); // DateTime
    expect(variantToNumber(v(11, [1, 2], 1))).toBeUndefined(); // array de Double
    expect(variantToNumber(v(11, null))).toBeUndefined(); // Double sem valor
    expect(variantToNumber(null)).toBeUndefined();
  });

  it('nomes de tipo para os logs', () => {
    expect(dataTypeName(11)).toBe('Double');
    expect(dataTypeName(12)).toBe('String');
    expect(dataTypeName(99)).toBe('DataType 99');
  });
});
