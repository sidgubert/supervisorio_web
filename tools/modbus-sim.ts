/**
 * Simulador de CLP Modbus TCP para desenvolvimento e aulas (npm run sim:modbus).
 *
 * Expõe sinais de processo que variam com o tempo, em vários tipos de dado,
 * para exercitar a fonte Modbus sem um equipamento real.
 *
 *   Endereço   Tipo      Conteúdo                           address da tag
 *   hr:0       uint16    pressão × 100 (bar)                hr:0?scale=0.01
 *   hr:1       int16     temperatura × 10 (°C, negativa)    hr:1?type=int16&scale=0.1
 *   hr:2–3     float32   vazão (m³/h)                       hr:2?type=float32
 *   ir:0       uint16    nível × 10 (%)                     ir:0?scale=0.1
 *   coil:0     bit       bomba ligada (alterna a cada 15 s) coil:0
 *   di:0       bit       chave de nível alto (nível > 70%)  di:0
 *
 * Variáveis: MODBUS_SIM_HOST (padrão 127.0.0.1), MODBUS_SIM_PORT (padrão 5020).
 * Responde a qualquer unit ID. Endereços fora do mapa respondem com a exceção
 * "illegal data address", como um CLP real.
 */
import { ServerTCP } from 'modbus-serial';
import { sampleSignal, SignalSpec } from '../src/sources/simulator/signal';

const host = process.env.MODBUS_SIM_HOST ?? '127.0.0.1';
const port = Number(process.env.MODBUS_SIM_PORT ?? 5020);

const PRESSURE: SignalSpec = {
  tag: 'pressão',
  mean: 4.2,
  amplitude: 0.6,
  periodSec: 90,
  noise: 0.05,
};
const TEMPERATURE: SignalSpec = {
  tag: 'temperatura',
  mean: -5,
  amplitude: 10,
  periodSec: 60,
  noise: 0.3,
};
const FLOW: SignalSpec = { tag: 'vazão', mean: 120, amplitude: 25, periodSec: 45, noise: 1.5 };
const LEVEL: SignalSpec = { tag: 'nível', mean: 60, amplitude: 15, periodSec: 120, noise: 0.8 };

const toU16 = (n: number) => (Math.round(n) + 0x10000) % 0x10000;

function holdingRegisters(now: number): number[] {
  const f = Buffer.alloc(4);
  f.writeFloatBE(sampleSignal(FLOW, now), 0);
  return [
    toU16(sampleSignal(PRESSURE, now) * 100),
    toU16(sampleSignal(TEMPERATURE, now) * 10),
    f.readUInt16BE(0),
    f.readUInt16BE(2),
  ];
}

const level = (now: number) => sampleSignal(LEVEL, now);
const pumpOn = (now: number) => Math.floor(now / 15_000) % 2 === 0;

function illegalAddress(): Error {
  return Object.assign(new Error('Illegal data address'), { modbusErrorCode: 0x02 });
}

const vector = {
  getHoldingRegister: (addr: number) => {
    const regs = holdingRegisters(Date.now());
    if (addr >= regs.length) throw illegalAddress();
    return regs[addr];
  },
  getMultipleHoldingRegisters: (addr: number, length: number) => {
    const regs = holdingRegisters(Date.now());
    if (addr + length > regs.length) throw illegalAddress();
    return regs.slice(addr, addr + length);
  },
  getInputRegister: (addr: number) => {
    if (addr !== 0) throw illegalAddress();
    return toU16(level(Date.now()) * 10);
  },
  getCoil: (addr: number) => {
    if (addr !== 0) throw illegalAddress();
    return pumpOn(Date.now());
  },
  getDiscreteInput: (addr: number) => {
    if (addr !== 0) throw illegalAddress();
    return level(Date.now()) > 70;
  },
};

const server = new ServerTCP(vector, { host, port, unitID: 255 });
server.on('initialized', () => {
  console.log(`Simulador Modbus TCP em ${host}:${port} (Ctrl+C para parar)`);
});
server.on('socketError', (err) => console.error('Erro de socket:', err?.message));

const report = setInterval(() => {
  const now = Date.now();
  console.log(
    [
      `pressão ${sampleSignal(PRESSURE, now).toFixed(2)} bar`,
      `temperatura ${sampleSignal(TEMPERATURE, now).toFixed(1)} °C`,
      `vazão ${sampleSignal(FLOW, now).toFixed(1)} m³/h`,
      `nível ${level(now).toFixed(1)} %`,
      `bomba ${pumpOn(now) ? 'ligada' : 'desligada'}`,
    ].join(' | '),
  );
}, 5000);

function shutdown() {
  clearInterval(report);
  for (const sock of server.socks.keys()) sock.destroy();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
