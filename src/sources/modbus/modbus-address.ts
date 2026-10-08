/**
 * Endereços Modbus das tags (campo `address`), leitura agrupada e decodificação.
 * Tudo em funções puras, testáveis sem equipamento.
 *
 * Formato do endereço:   <área>:<offset>[?unit=1&type=uint16&scale=1&swap=false]
 *
 *   hr:0                       holding register 0 (= 40001 na notação clássica), uint16
 *   ir:10?type=int16&scale=0.1 input register 10, com sinal, × 0,1
 *   hr:4?type=float32          float em 2 registradores (palavra alta primeiro)
 *   hr:4?type=float32&swap=true   palavras invertidas (ordem "CDAB")
 *   coil:3                     coil 3 (1/0)
 *   di:7?unit=2                discrete input 7 do escravo 2
 *
 * Offsets começam em 0 (endereço do protocolo, não o número "4xxxx").
 */

export type ModbusArea = 'hr' | 'ir' | 'coil' | 'di';
export type ModbusType = 'uint16' | 'int16' | 'uint32' | 'int32' | 'float32' | 'bool';

export interface ModbusAddress {
  /** Unit ID (escravo), 0–255. Padrão 1. */
  unit: number;
  area: ModbusArea;
  /** Endereço do primeiro registrador/bit (0–65535). */
  offset: number;
  type: ModbusType;
  /** Registradores (ou bits) ocupados: 2 para tipos de 32 bits, senão 1. */
  length: number;
  /** Multiplicador aplicado ao valor bruto. */
  scale: number;
  /** Tipos de 32 bits: palavra baixa primeiro. */
  swap: boolean;
}

const AREAS: readonly ModbusArea[] = ['hr', 'ir', 'coil', 'di'];
const REGISTER_TYPES: readonly ModbusType[] = ['uint16', 'int16', 'uint32', 'int32', 'float32'];
const OPTIONS = ['unit', 'type', 'scale', 'swap'];
const EXAMPLE = 'ex: hr:0, ir:10?type=int16&scale=0.1, coil:3';

export function parseModbusAddress(
  address: string | null | undefined,
): ModbusAddress | { error: string } {
  if (!address) return { error: `informe o endereço Modbus (${EXAMPLE})` };

  const [location, query = ''] = address.trim().split('?', 2);
  const match = /^([a-z]+):(\d+)$/i.exec(location);
  if (!match) return { error: `formato inválido; esperado <área>:<offset> (${EXAMPLE})` };

  const area = match[1].toLowerCase() as ModbusArea;
  if (!AREAS.includes(area)) return { error: `área deve ser ${AREAS.join(', ')}` };
  const offset = Number(match[2]);
  if (offset > 65535) return { error: 'offset deve estar entre 0 e 65535' };

  const params = new URLSearchParams(query);
  for (const key of params.keys()) {
    if (!OPTIONS.includes(key))
      return { error: `opção desconhecida "${key}" (use ${OPTIONS.join(', ')})` };
  }

  const isBit = area === 'coil' || area === 'di';
  const type = (params.get('type')?.toLowerCase() ?? (isBit ? 'bool' : 'uint16')) as ModbusType;
  if (isBit && type !== 'bool') return { error: `${area} só aceita type=bool` };
  if (!isBit && !REGISTER_TYPES.includes(type)) {
    return { error: `type deve ser ${REGISTER_TYPES.join(', ')}` };
  }
  const length = type === 'uint32' || type === 'int32' || type === 'float32' ? 2 : 1;
  if (offset + length - 1 > 65535) return { error: 'o valor ultrapassa o endereço 65535' };

  const unitText = params.get('unit') ?? '1';
  const unit = Number(unitText);
  if (!/^\d+$/.test(unitText) || unit > 255)
    return { error: 'unit deve ser inteiro entre 0 e 255' };

  const scaleText = params.get('scale') ?? '1';
  const scale = Number(scaleText);
  if (scaleText.trim() === '' || !Number.isFinite(scale) || scale === 0) {
    return { error: 'scale deve ser um número diferente de zero' };
  }

  const swapText = (params.get('swap') ?? 'false').toLowerCase();
  if (swapText !== 'true' && swapText !== 'false') return { error: 'swap deve ser true ou false' };
  const swap = swapText === 'true';
  if (swap && length !== 2) return { error: 'swap só se aplica a tipos de 32 bits' };

  return { unit, area, offset, type, length, scale, swap };
}

/** Validador para o cadastro de tags: mensagem de erro, ou undefined se ok. */
export function validateModbusAddress(address: string | null | undefined): string | undefined {
  const parsed = parseModbusAddress(address);
  return 'error' in parsed ? parsed.error : undefined;
}

export interface ReadItem {
  tag: string;
  addr: ModbusAddress;
}

/** Uma leitura Modbus (um request) e as tags que ela atende. */
export interface ReadBlock {
  unit: number;
  area: ModbusArea;
  start: number;
  length: number;
  items: ReadItem[];
}

/** Limites do protocolo por request: 125 registradores (FC3/FC4), 2000 bits (FC1/FC2). */
export const MAX_REGISTERS_PER_READ = 125;
export const MAX_BITS_PER_READ = 2000;

/**
 * Agrupa as tags em leituras: endereços contíguos ou sobrepostos do mesmo
 * escravo e área viram um único request, até o limite do protocolo.
 *
 * Só junta endereços encostados (sem lacunas): ler um "buraco" no mapa de
 * registradores pode fazer o equipamento responder com exceção
 * (illegal data address) e derrubar a leitura do bloco inteiro.
 */
export function planReads(items: ReadItem[]): ReadBlock[] {
  const groups = new Map<string, ReadItem[]>();
  for (const item of items) {
    const key = `${item.addr.unit}:${item.addr.area}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  const blocks: ReadBlock[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.addr.offset - b.addr.offset);
    const { unit, area } = group[0].addr;
    const max = area === 'coil' || area === 'di' ? MAX_BITS_PER_READ : MAX_REGISTERS_PER_READ;
    let block: ReadBlock | undefined;
    for (const item of group) {
      const end = item.addr.offset + item.addr.length;
      const blockEnd = block ? block.start + block.length : -1;
      if (block && item.addr.offset <= blockEnd && Math.max(end, blockEnd) - block.start <= max) {
        block.length = Math.max(end, blockEnd) - block.start;
        block.items.push(item);
      } else {
        block = { unit, area, start: item.addr.offset, length: item.addr.length, items: [item] };
        blocks.push(block);
      }
    }
  }
  return blocks;
}

/**
 * Valor de engenharia de uma tag a partir dos dados lidos do bloco
 * (registradores de 16 bits, ou bits). NaN/Infinity (float32 inválido) são
 * descartados depois pela validação da ingestão.
 */
export function decodeItem(block: ReadBlock, item: ReadItem, data: number[] | boolean[]): number {
  const i = item.addr.offset - block.start;
  if (item.addr.type === 'bool') return (data as boolean[])[i] ? 1 : 0;

  const regs = data as number[];
  let raw: number;
  if (item.addr.length === 1) {
    raw = regs[i];
    if (item.addr.type === 'int16' && raw > 0x7fff) raw -= 0x10000;
  } else {
    const [hi, lo] = item.addr.swap ? [regs[i + 1], regs[i]] : [regs[i], regs[i + 1]];
    const buf = Buffer.alloc(4);
    buf.writeUInt16BE(hi, 0);
    buf.writeUInt16BE(lo, 2);
    raw =
      item.addr.type === 'float32'
        ? buf.readFloatBE(0)
        : item.addr.type === 'int32'
          ? buf.readInt32BE(0)
          : buf.readUInt32BE(0);
  }
  const value = raw * item.addr.scale;
  // float32 tem ~7 dígitos significativos; além disso é só artefato da
  // conversão para double (12.3 vira 12.300000190734863).
  if (item.addr.type === 'float32') return Number(value.toPrecision(7));
  // Inteiro × escala tem no máximo as casas decimais da escala; arredondar
  // remove o ruído de ponto flutuante (-147 × 0.1 = -14.700000000000001).
  return Number(value.toFixed(decimalPlaces(item.addr.scale)));
}

/** Casas decimais de um número, inclusive em notação exponencial (1e-7 → 7). */
function decimalPlaces(n: number): number {
  const [mantissa, exponent = '0'] = String(n).toLowerCase().split('e');
  const fraction = mantissa.split('.')[1]?.length ?? 0;
  return Math.min(20, Math.max(0, fraction - Number(exponent)));
}
