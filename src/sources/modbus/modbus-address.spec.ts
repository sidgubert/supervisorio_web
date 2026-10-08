import {
  decodeItem,
  ModbusAddress,
  parseModbusAddress,
  planReads,
  ReadItem,
  validateModbusAddress,
} from './modbus-address';

const addr = (address: string) => parseModbusAddress(address) as ModbusAddress;
const item = (tag: string, address: string): ReadItem => ({ tag, addr: addr(address) });

describe('parseModbusAddress', () => {
  it('aplica os padrões: unit 1, uint16, escala 1', () => {
    expect(parseModbusAddress('hr:0')).toEqual({
      unit: 1,
      area: 'hr',
      offset: 0,
      type: 'uint16',
      length: 1,
      scale: 1,
      swap: false,
    });
  });

  it('lê as opções e não diferencia maiúsculas na área e no tipo', () => {
    expect(parseModbusAddress('IR:10?type=INT32&scale=0.1&unit=2&swap=true')).toEqual({
      unit: 2,
      area: 'ir',
      offset: 10,
      type: 'int32',
      length: 2,
      scale: 0.1,
      swap: true,
    });
  });

  it('coil e di são booleanos', () => {
    expect(parseModbusAddress('coil:3')).toMatchObject({ area: 'coil', type: 'bool', length: 1 });
    expect(parseModbusAddress('di:65535')).toMatchObject({ area: 'di', offset: 65535 });
  });

  it.each([
    [null, /informe o endereço/],
    ['40001', /formato inválido/],
    ['hr:-1', /formato inválido/],
    ['hr:1.5', /formato inválido/],
    ['xx:0', /área deve ser/],
    ['hr:65536', /offset deve estar/],
    ['hr:65535?type=float32', /ultrapassa o endereço/],
    ['hr:0?tipo=int16', /opção desconhecida "tipo"/],
    ['hr:0?type=float64', /type deve ser/],
    ['coil:0?type=int16', /só aceita type=bool/],
    ['hr:0?unit=256', /unit deve ser/],
    ['hr:0?unit=1.5', /unit deve ser/],
    ['hr:0?scale=0', /scale deve ser/],
    ['hr:0?scale=abc', /scale deve ser/],
    ['hr:0?swap=sim', /swap deve ser/],
    ['hr:0?swap=true', /swap só se aplica/],
  ])('recusa %j', (address, msg) => {
    expect(validateModbusAddress(address)).toMatch(msg);
  });
});

describe('planReads', () => {
  it('junta endereços contíguos e sobrepostos num só request', () => {
    const blocks = planReads([
      item('C', 'hr:2?type=float32'), // 2–3
      item('A', 'hr:0'),
      item('B', 'hr:1'),
      item('D', 'hr:3'), // sobreposto ao float
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ unit: 1, area: 'hr', start: 0, length: 4 });
    expect(blocks[0].items.map((i) => i.tag)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('não junta através de lacunas, nem áreas ou escravos diferentes', () => {
    const blocks = planReads([
      item('A', 'hr:0'),
      item('B', 'hr:2'),
      item('C', 'ir:1'),
      item('D', 'hr:1?unit=2'),
      item('E', 'coil:0'),
    ]);
    expect(blocks.map((b) => `${b.unit}:${b.area}:${b.start}+${b.length}`).sort()).toEqual([
      '1:coil:0+1',
      '1:hr:0+1',
      '1:hr:2+1',
      '1:ir:1+1',
      '2:hr:1+1',
    ]);
  });

  it('respeita o limite de 125 registradores por request', () => {
    const items = Array.from({ length: 130 }, (_, i) => item(`T${i}`, `hr:${i}`));
    const blocks = planReads(items);
    expect(blocks.map((b) => [b.start, b.length])).toEqual([
      [0, 125],
      [125, 5],
    ]);
  });

  it('respeita o limite de 2000 bits por request', () => {
    const items = Array.from({ length: 2001 }, (_, i) => item(`T${i}`, `coil:${i}`));
    expect(planReads(items).map((b) => b.length)).toEqual([2000, 1]);
  });
});

describe('decodeItem', () => {
  const decode = (address: string, data: number[] | boolean[], start = 0) => {
    const it = item('T', address);
    return decodeItem(
      { unit: 1, area: it.addr.area, start, length: data.length, items: [it] },
      it,
      data,
    );
  };

  it('uint16 e int16', () => {
    expect(decode('hr:0', [65535])).toBe(65535);
    expect(decode('hr:0?type=int16', [65535])).toBe(-1);
    expect(decode('hr:0?type=int16', [32767])).toBe(32767);
  });

  it('usa a posição do item dentro do bloco', () => {
    expect(decode('hr:12', [1, 2, 3], 10)).toBe(3);
  });

  it('32 bits: palavra alta primeiro, ou invertida com swap', () => {
    // 0x00010002 = 65538
    expect(decode('hr:0?type=uint32', [0x0001, 0x0002])).toBe(65538);
    expect(decode('hr:0?type=uint32&swap=true', [0x0002, 0x0001])).toBe(65538);
    // -2 = 0xFFFFFFFE
    expect(decode('hr:0?type=int32', [0xffff, 0xfffe])).toBe(-2);
  });

  it('float32 (IEEE 754)', () => {
    const buf = Buffer.alloc(4);
    buf.writeFloatBE(21.5, 0);
    const regs = [buf.readUInt16BE(0), buf.readUInt16BE(2)];
    expect(decode('hr:0?type=float32', regs)).toBe(21.5);
    expect(decode('hr:0?type=float32&swap=true', [regs[1], regs[0]])).toBe(21.5);
  });

  it('aplica a escala sem ruído de ponto flutuante', () => {
    expect(decode('ir:0?type=int16&scale=0.1', [65526])).toBe(-1);
    expect(decode('hr:0?type=int16&scale=0.1', [65389])).toBe(-14.7); // e não -14.700000000000001
    expect(decode('hr:0?scale=0.01', [471])).toBe(4.71);
    expect(decode('hr:0?scale=0.25', [3])).toBe(0.75);
    expect(decode('hr:0?scale=1e-7', [3])).toBe(3e-7);
    expect(decode('hr:0?scale=1000', [3])).toBe(3000);
  });

  it('float32 limitado à sua precisão (7 dígitos significativos)', () => {
    const buf = Buffer.alloc(4);
    buf.writeFloatBE(12.3, 0); // em float32, 12.300000190734863
    expect(decode('hr:0?type=float32', [buf.readUInt16BE(0), buf.readUInt16BE(2)])).toBe(12.3);
  });

  it('bits viram 1/0', () => {
    expect(decode('coil:0', [true])).toBe(1);
    expect(decode('di:1', [true, false])).toBe(0);
  });
});
