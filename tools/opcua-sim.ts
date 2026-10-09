/**
 * Simulador de servidor OPC UA para desenvolvimento e aulas (npm run sim:opcua).
 *
 * Variáveis (namespace 1), atualizadas a cada 500 ms com sourceTimestamp:
 *
 *   NodeId                       Tipo      Conteúdo
 *   ns=1;s=Reator.Temperatura    Double    temperatura (°C), senoide
 *   ns=1;s=Reator.Pressao        Float     pressão (bar), senoide
 *   ns=1;s=Bomba.Ligada          Boolean   alterna a cada 15 s
 *   ns=1;s=Linha.Pecas           UInt32    contador de peças (+1 a cada 2 s)
 *   ns=1;s=Linha.Status          String    texto (não numérico: a fonte ignora)
 *   ns=1;s=Sensor.Instavel       Double    fica Bad (BadSensorFailure) 10 s a cada minuto
 *
 * Variáveis: OPCUA_SIM_PORT (padrão 4840) e OPCUA_SIM_PKI_DIR (certificado do
 * servidor; padrão: pasta temporária). Endpoint: opc.tcp://localhost:<porta>
 *
 * Aceita conexões sem segurança (None) e seguras (Sign e SignAndEncrypt, com
 * as políticas Basic256Sha256, Aes128_Sha256_RsaOaep e Aes256_Sha256_RsaPss),
 * para testar OPCUA_SECURITY_MODE. Confia em qualquer certificado de cliente
 * e o acesso é anônimo: só para laboratório.
 */
import {
  DataType,
  MessageSecurityMode,
  SecurityPolicy,
  StatusCodes,
  Variant,
  VariantArrayType,
} from 'node-opcua-client';
import { OPCUACertificateManager } from 'node-opcua-certificate-manager';
import { OPCUAServer } from 'node-opcua-server';
import { tmpdir } from 'os';
import { join } from 'path';
import { sampleSignal, SignalSpec } from '../src/sources/simulator/signal';

const port = Number(process.env.OPCUA_SIM_PORT ?? 4840);

const TEMPERATURE: SignalSpec = {
  tag: 'temperatura',
  mean: 75,
  amplitude: 8,
  periodSec: 60,
  noise: 0.4,
};
const PRESSURE: SignalSpec = {
  tag: 'pressão',
  mean: 4.2,
  amplitude: 0.6,
  periodSec: 90,
  noise: 0.05,
};
const UNSTABLE: SignalSpec = { tag: 'instável', mean: 50, amplitude: 5, periodSec: 30, noise: 0.5 };

async function main() {
  const server = new OPCUAServer({
    port,
    resourcePath: '',
    allowAnonymous: true,
    securityModes: [
      MessageSecurityMode.None,
      MessageSecurityMode.Sign,
      MessageSecurityMode.SignAndEncrypt,
    ],
    securityPolicies: [
      SecurityPolicy.None,
      SecurityPolicy.Basic256Sha256,
      SecurityPolicy.Aes128_Sha256_RsaOaep,
      SecurityPolicy.Aes256_Sha256_RsaPss,
    ],
    buildInfo: { productName: 'TALOS simulador OPC UA' },
    // Certificado do servidor numa pasta reaproveitada entre execuções.
    serverCertificateManager: new OPCUACertificateManager({
      rootFolder: process.env.OPCUA_SIM_PKI_DIR ?? join(tmpdir(), 'talos-opcua-sim-pki'),
      automaticallyAcceptUnknownCertificate: true,
    }),
  });
  await server.initialize();

  const addressSpace = server.engine.addressSpace!;
  const ns = addressSpace.getOwnNamespace();
  const add = (parent: string, name: string, dataType: DataType) => {
    const folder =
      ns.findNode(`s=${parent}`) ??
      ns.addObject({
        organizedBy: addressSpace.rootFolder.objects,
        browseName: parent,
        nodeId: `s=${parent}`,
      });
    return ns.addVariable({
      componentOf: folder,
      browseName: name,
      nodeId: `s=${parent}.${name}`,
      dataType: DataType[dataType],
    });
  };
  const vars = {
    temperatura: add('Reator', 'Temperatura', DataType.Double),
    pressao: add('Reator', 'Pressao', DataType.Float),
    bomba: add('Bomba', 'Ligada', DataType.Boolean),
    pecas: add('Linha', 'Pecas', DataType.UInt32),
    status: add('Linha', 'Status', DataType.String),
    instavel: add('Sensor', 'Instavel', DataType.Double),
  };

  const set = (
    v: (typeof vars)[keyof typeof vars],
    dataType: DataType,
    value: unknown,
    status = StatusCodes.Good,
  ) =>
    v.setValueFromSource(
      new Variant({ dataType, arrayType: VariantArrayType.Scalar, value }),
      status,
      new Date(),
    );

  const start = Date.now();
  const tick = () => {
    const now = Date.now();
    const pumpOn = Math.floor(now / 15_000) % 2 === 0;
    const pieces = Math.floor((now - start) / 2000);
    const failing = new Date(now).getSeconds() < 10; // 10 s de falha a cada minuto
    set(vars.temperatura, DataType.Double, sampleSignal(TEMPERATURE, now));
    set(vars.pressao, DataType.Float, sampleSignal(PRESSURE, now));
    set(vars.bomba, DataType.Boolean, pumpOn);
    set(vars.pecas, DataType.UInt32, pieces);
    set(vars.status, DataType.String, pumpOn ? 'produzindo' : 'parada');
    set(
      vars.instavel,
      DataType.Double,
      sampleSignal(UNSTABLE, now),
      failing ? StatusCodes.BadSensorFailure : StatusCodes.Good,
    );
  };
  tick();
  const timer = setInterval(tick, 500);

  await server.start();
  console.log(`Simulador OPC UA em opc.tcp://localhost:${port} (Ctrl+C para parar)`);
  console.log(
    'NodeIds: ' +
      Object.values(vars)
        .map((v) => v.nodeId.toString())
        .join(', '),
  );

  const shutdown = async () => {
    clearInterval(timer);
    await server.shutdown(0);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error('Falha ao iniciar o simulador OPC UA:', err);
  process.exit(1);
});
