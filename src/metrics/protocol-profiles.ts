/** Perfis educacionais para comparar os protocolos de aquisição (Fase 5). */
export interface ProtocolProfile {
  id: string;
  name: string;
  paradigm: string;
  transport: string;
  typicalUse: string;
  complexity: 'baixa' | 'média' | 'alta';
  realtime: string;
  notes: string;
}

export const PROTOCOL_PROFILES: ProtocolProfile[] = [
  {
    id: 'sim',
    name: 'Simulador interno',
    paradigm: 'Geração local',
    transport: 'Memória',
    typicalUse: 'Teste de carga e demonstração',
    complexity: 'baixa',
    realtime: 'Configurável (SIM_INTERVAL_MS)',
    notes: 'Valida o caminho NestJS → TimescaleDB sem nenhum equipamento.',
  },
  {
    id: 'mqtt',
    name: 'MQTT',
    paradigm: 'Publish/Subscribe',
    transport: 'TCP, via broker',
    typicalUse: 'IoT, telemetria distribuída, edge',
    complexity: 'baixa',
    realtime: 'Por evento (push)',
    notes: 'Baixo overhead; o dispositivo publica quando quer, e o broker distribui.',
  },
  {
    id: 'modbus',
    name: 'Modbus TCP',
    paradigm: 'Request/Response (cliente/servidor)',
    transport: 'TCP, porta 502',
    typicalUse: 'CLPs, medidores, inversores',
    complexity: 'média',
    realtime: 'Polling (pull)',
    notes: 'Padrão industrial legado; a latência depende do intervalo de leitura.',
  },
  {
    id: 'opcua',
    name: 'OPC UA',
    paradigm: 'Cliente/Servidor com subscriptions',
    transport: 'TCP binário (opc.tcp)',
    typicalUse: 'Chão de fábrica moderno, interoperabilidade',
    complexity: 'alta',
    realtime: 'Subscription (push) ou leitura',
    notes: 'Modelo de informação rico, StatusCode e horário da fonte; segurança com certificados.',
  },
];
