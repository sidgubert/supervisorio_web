# SCADA-EDU — Backend (Fase 1)

Sistema supervisório web educacional 4.0. Esqueleto da **Fase 1**: banco de
séries temporais, backend NestJS e o "Teste de Carga Simulado" (gerador de
senoides que persiste continuamente no banco).

## Stack desta fase

- **TimescaleDB** (extensão do PostgreSQL) — banco de séries temporais.
- **NestJS** sobre **Express** (adaptador HTTP padrão do Nest).
- **TypeORM** + driver `pg` — acesso ao banco.
- **TypeScript** — tipagem estática das variáveis de processo.

## Pré-requisitos

- Docker + Docker Compose
- Node.js 20+

## Passo a passo

```bash
# 1. Copie as variáveis de ambiente
cp .env.example .env

# 2. Suba o banco (cria a extensão + hypertable automaticamente)
docker compose up -d
#    (opcional) cliente web em http://localhost:8080 :
#    docker compose --profile tools up -d

# 3. Instale as dependências do backend
npm install

# 4. Rode o backend em modo desenvolvimento
npm run start:dev
```

Com `SIM_ENABLED=true`, o simulador começa a gerar amostras imediatamente.
Para confirmar que os dados estão sendo persistidos:

```bash
docker exec -it scada-timescaledb \
  psql -U scada -d scada -c \
  "SELECT tag, count(*), max(time) FROM measurements GROUP BY tag;"
```

## Estrutura

```
docker-compose.yml      TimescaleDB (+ Adminer opcional)
db/init.sql             extensão timescaledb + hypertable measurements
src/
  main.ts               bootstrap da API (CORS, porta, shutdown hooks)
  app.module.ts         config + conexão TypeORM
  app.controller.ts     GET / e GET /health (verifica o banco; 503 se fora)
  config/
    env.validation.ts   validação/conversão das variáveis de ambiente
  measurements/         entidade + service (insert em lote, consulta)
  simulator/
    signal.ts           geração de senoides (lógica pura, testável)
    simulator.service.ts loop de geração + flush em lote no banco
```

## Configuração

Todas as variáveis estão em `.env.example`. Elas são validadas na subida:
se alguma estiver inválida (ex: `SIM_INTERVAL_MS=abc`), a API não sobe e
lista os problemas.

`SIM_BUFFER_MAX` limita o buffer em memória do simulador: se o banco ficar
fora do ar, as amostras mais antigas são descartadas (com aviso no log) em
vez de a memória crescer sem limite.

## Endpoints

- `GET /health` — `200 {status:'ok', db:'up'}` ou `503` se o banco não responder.
- `GET /measurements/:tag/latest?limit=100` — últimas amostras da tag
  (`limit` entre 1 e 5000).

## Modelo de dados

Tabela única `measurements` em formato *long* (uma linha por amostra de cada
tag): `time, tag, value, quality, source`. Esse formato evita alterar o schema
ao adicionar novas tags e é o recomendado para hypertables.

O campo `source` (`sim` por enquanto) já antecipa a Fase 2: distinguir a
origem dos dados entre `mqtt`, `modbus`, `opcua`.

## Próximos passos (Fase 2)

- Trocar/complementar a fonte `sim` por adquisição real via MQTT, Modbus TCP
  e OPC UA, reaproveitando `MeasurementsService.insertBatch`.
- Middleware de normalização de payload dos três protocolos para o mesmo
  formato `Sample`.
