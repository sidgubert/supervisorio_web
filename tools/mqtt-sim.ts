/**
 * Simulador de dispositivos MQTT para desenvolvimento e aulas (npm run sim:mqtt).
 *
 * Publica, a cada MQTT_SIM_INTERVAL_MS, uma leitura em cada tópico
 * talos/sim/001, talos/sim/002..., em JSON com o horário da medição:
 *
 *   {"value": 75.123, "time": "2026-10-08T12:00:00.000Z"}
 *
 * Com o horário na mensagem, a API grava o instante da medição (e não o da
 * chegada), e a diferença entre os dois mede a latência do caminho
 * dispositivo → broker → API. Os valores vêm do mesmo gerador de senoides do
 * simulador interno.
 *
 * Variáveis: MQTT_SIM_URL (padrão mqtt://localhost:1883), MQTT_SIM_TOPICS
 * (padrão 4), MQTT_SIM_INTERVAL_MS (padrão 1000), MQTT_SIM_QOS (0 ou 1,
 * padrão 1). Para a fonte MQTT gravar, cadastre uma tag por tópico:
 *
 *   curl -X POST localhost:3000/api/tags -H 'Content-Type: application/json' \
 *     -d '{"tag":"MQTT-001.PV","source":"mqtt","address":"talos/sim/001"}'
 */
import { connect } from 'mqtt';
import { generatedSignal, sampleSignal } from '../src/sources/simulator/signal';

const url = process.env.MQTT_SIM_URL ?? 'mqtt://localhost:1883';
const count = Number(process.env.MQTT_SIM_TOPICS ?? 4);
const interval = Number(process.env.MQTT_SIM_INTERVAL_MS ?? 1000);
const qos = process.env.MQTT_SIM_QOS === '0' ? 0 : 1;

if (!Number.isInteger(count) || count < 1 || !Number.isFinite(interval) || interval < 10) {
  console.error('MQTT_SIM_TOPICS deve ser inteiro >= 1 e MQTT_SIM_INTERVAL_MS >= 10');
  process.exit(1);
}

/** Um sinal por tópico, com parâmetros fixos (os mesmos a cada execução). */
const topics = Array.from({ length: count }, (_, i) => ({
  topic: `talos/sim/${String(i + 1).padStart(3, '0')}`,
  spec: { ...generatedSignal(i + 5), tag: `mqtt-${i + 1}` },
}));

const client = connect(url, { clientId: `talos-mqtt-sim-${process.pid}`, reconnectPeriod: 2000 });
let sent = 0;
client.on('connect', () => console.log(`Simulador MQTT conectado a ${url}`));
client.on('error', (err) => console.error(`Erro MQTT: ${err.message}`));

const timer = setInterval(() => {
  if (!client.connected) return;
  const now = Date.now();
  const time = new Date(now).toISOString();
  for (const { topic, spec } of topics) {
    client.publish(topic, JSON.stringify({ value: sampleSignal(spec, now), time }), { qos });
    sent++;
  }
}, interval);

const report = setInterval(() => console.log(`${sent} mensagens publicadas`), 30_000);
console.log(
  `Publicando ${count} tópicos (${topics[0].topic}...) a cada ${interval} ms, QoS ${qos} (Ctrl+C para parar)`,
);

const shutdown = () => {
  clearInterval(timer);
  clearInterval(report);
  client.end(false, {}, () => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
