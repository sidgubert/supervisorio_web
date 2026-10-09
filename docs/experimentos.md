# Experimentos

Roteiro e resultados da avaliação experimental do TALOS (Seção 9 do documento
técnico do trabalho). Cada experimento usa uma ferramenta de `tools/`, e todos
podem ser repetidos com os comandos abaixo.

## Como reproduzir

Use um banco separado do de desenvolvimento, para não misturar os dados de
teste de carga:

```bash
docker run -d --name talos-exp-db -p 5434:5432 \
  -e POSTGRES_USER=talos -e POSTGRES_PASSWORD=talos -e POSTGRES_DB=talos \
  timescale/timescaledb:2.27.1-pg16
export DB_PORT=5434 DB_USER=talos DB_PASSWORD=talos DB_NAME=talos PORT=3092
npm run build

# Gravação em lote x linha a linha, e alarmes (este último sem banco)
npm run bench:insert -- --rows=10000 --runs=3
npm run bench:alarms -- --limit=140 --sample-ms=100

# Carga: N tags a cada X ms; depois de 2,5 min, as métricas
SIM_TAGS=1000 SIM_INTERVAL_MS=100 node dist/main.js &
curl localhost:3092/api/metrics/overview

# Protocolos: suba os simuladores (docker compose --profile simulators up -d),
# ligue as fontes, cadastre as tags e, com a API rodando:
npm run report:acquisition -- --minutes=4
npm run bench:sse -- --url=http://localhost:3092 --seconds=60

# Resiliência: com a API gravando, derrube o banco por 60 s e confira
docker stop talos-exp-db && sleep 60 && docker start talos-exp-db
npm run sim:verify -- --minutes=2.5
```

As ferramentas aceitam `--out=arquivo.json` para gravar o resultado bruto.

## 1. Ambiente e Método

Os experimentos foram executados numa única máquina, com o banco, o broker MQTT e os simuladores em containers isolados (sem relação com o ambiente de desenvolvimento) e a API compilada rodando diretamente no sistema (`node dist/main.js`).

_Tabela 1 – Ambiente dos experimentos_

| Item                | Configuração                                          |
| ------------------- | ----------------------------------------------------- |
| Processador         | Intel Core i7-10750H (6 núcleos, 12 threads, 2,6 GHz) |
| Memória             | 32 GB                                                 |
| Sistema operacional | Windows 11                                            |
| Containers          | Docker 29.8 (VM Linux com 12 CPUs e 15,6 GiB)         |
| Banco               | TimescaleDB 2.27.1 (PostgreSQL 16)                    |
| API                 | Node.js 24.14, build de produção                      |

Cada experimento tem uma ferramenta no repositório (pasta `tools/`), e todos podem ser reproduzidos com os comandos da seção acima. Como API, banco e simuladores dividem a mesma máquina, os números indicam ordens de grandeza e comparações entre configurações, e não a capacidade de um servidor dedicado.

## 2. Gravação em Lote versus Linha a Linha

`npm run bench:insert` grava 10.000 linhas numa hypertable temporária com a mesma estrutura de `measurements`, de cinco formas, e repete cada uma 3 vezes (mediana). O lote usa a mesma instrução da ingestão (`INSERT ... SELECT FROM unnest`).

_Tabela 2 – Vazão de gravação por método_

| Método                                | Tempo (s) | Linhas/s | Ganho |
| ------------------------------------- | --------- | -------- | ----- |
| Linha a linha (1 transação por linha) | 13,08     | 765      | 1,0×  |
| Linha a linha (todas em 1 transação)  | 6,31      | 1.586    | 2,1×  |
| Lotes de 100 (unnest)                 | 0,60      | 16.683   | 21,8× |
| Lotes de 1.000 (unnest)               | 0,41      | 24.487   | 32,0× |
| Lotes de 10.000 (unnest)              | 0,44      | 22.535   | 29,5× |

Gravar linha a linha, cada uma na sua transação, sustentou cerca de 765 linhas/s: cada INSERT paga uma ida e volta na rede e um commit. Pôr todas numa transação só multiplicou a vazão por 2,1, o que mostra o peso do commit; o custo dominante, porém, é a ida e volta por linha. Em lote, uma única instrução grava milhares de linhas: 24.487 linhas/s com lotes de 1.000, 32 vezes a gravação ingênua.

_Tabela 3 – Latência de um INSERT em lote, por tamanho do lote_

| Linhas no lote | Média (ms) | p50 (ms) | p95 (ms) | ms por linha |
| -------------- | ---------- | -------- | -------- | ------------ |
| 1              | 1,69       | 1,44     | 2,08     | 1,686        |
| 10             | 2,58       | 1,80     | 9,09     | 0,258        |
| 20             | 2,37       | 2,10     | 2,56     | 0,119        |
| 100            | 6,30       | 5,98     | 8,78     | 0,063        |
| 1.000          | 38,12      | 36,62    | 42,66    | 0,038        |
| 10.000         | 381,06     | 373,80   | 434,10   | 0,038        |

Um lote de 10 a 20 linhas levou em média de 2,4 a 2,6 ms, o que confirma o valor de menos de 5 ms registrado nos primeiros testes do projeto. O custo por linha cai de 1,69 ms (lote de uma linha) para 0,038 ms a partir de 1.000 linhas, quando o tempo passa a crescer em proporção ao volume: lotes maiores não aumentam mais a vazão.

## 3. Escalabilidade da Ingestão

Com o simulador como gerador de carga (`SIM_TAGS` e `SIM_INTERVAL_MS`), a API foi executada com quantidades crescentes de tags e intervalos menores. Após 90 s em cada nível, foram registradas as amostras gravadas por segundo (janela de 60 s do coletor de métricas), as descartadas pelo buffer e o uso de CPU da API.

_Tabela 4 – Ingestão antes da correção do buffer_

| Tags × intervalo | Oferecidas/s | Gravadas/s | Descartadas | CPU da API |
| ---------------- | ------------ | ---------- | ----------- | ---------- |
| 4 × 1.000 ms     | 4            | 4          | 0           | 0,2%       |
| 100 × 1.000 ms   | 100          | 97         | 0           | 0,4%       |
| 1.000 × 1.000 ms | 1.000        | 967        | 0           | 2,2%       |
| 5.000 × 1.000 ms | 5.000        | 4.833      | 0           | 8,1%       |
| 1.000 × 100 ms   | 10.000       | 5.000      | 259.000     | 11,9%      |
| 2.000 × 100 ms   | 20.000       | 4.833      | 968.000     | 17,4%      |

Até 5 mil amostras/s, tudo o que foi gerado foi gravado. Acima disso, a vazão parou em cerca de 5 mil amostras/s, embora o banco suporte mais de 24.487 linhas/s (Seção 2), e o buffer passou a descartar amostras: 259.000 em 90 s a 10 mil amostras/s, e 968.000 a 20 mil amostras/s. A causa estava no buffer: cada ciclo de gravação (`INGEST_FLUSH_MS`, 2 s) gravava no máximo um lote de 10 mil amostras, o que limita a vazão a 10.000 / 2 s = 5 mil amostras/s, qualquer que seja a capacidade do banco.

A correção manteve o tamanho máximo de cada INSERT, mas, havendo acúmulo, o ciclo grava lotes seguidos até esvaziar o que havia no seu início.

A correção foi validada pelos testes automatizados do buffer: com acúmulo, ele grava lotes seguidos de até 10 mil amostras, na ordem de chegada, deixa para o ciclo seguinte o que chega durante a gravação e para na primeira falha do banco. A repetição deste experimento acima de 5 mil amostras/s com a correção ficou como próximo passo; espera-se que o teto passe a ser o do próprio banco, na ordem de 20 mil linhas/s nesta máquina (Seção 2).

## 4. Aquisição por Protocolo

Com o simulador interno e os três protocolos ativos ao mesmo tempo, quatro tags cada, `npm run report:acquisition` calculou a latência de aquisição (`received_at − time`) de cada fonte nos últimos 4 minutos de uma execução de 5 minutos. O Modbus fez polling a cada 1 s e o OPC UA usou amostragem e publicação de 1 s; o simulador MQTT publicou a cada 1 s, com o horário da medição na mensagem.

_Tabela 5 – Latência de aquisição por fonte (sem segurança no OPC UA)_

| Fonte      | Tags | Amostras | Média (ms) | p50 (ms) | p95 (ms) | Máx. (ms) |
| ---------- | ---- | -------- | ---------- | -------- | -------- | --------- |
| Simulador  | 4    | 948      | 0,0        | 0,0      | 0,0      | 1,0       |
| MQTT       | 4    | 952      | 2,6        | 2,0      | 6,0      | 7,0       |
| Modbus TCP | 4    | 948      | 0,0        | 0,0      | 0,0      | 0,0       |
| OPC UA     | 4    | 797      | 652,7      | 657,0    | 734,0    | 744,0     |

- **Simulador:** a amostra nasce na própria API, e a latência é praticamente zero.
- **MQTT:** 2 ms na mediana (6 ms no p95), o caminho dispositivo → broker → API na mesma máquina.
- **Modbus TCP:** zero por definição: o protocolo não informa o horário da medição, e a API usa o instante de recebimento. O atraso real é o do polling, de até um intervalo (1 s).
- **OPC UA:** cerca de 653 ms, dominados pelo intervalo de publicação da assinatura: o servidor amostra o valor e acumula as notificações até a próxima publicação. Reduzir `OPCUA_SAMPLING_MS` reduz a latência, ao custo de mais mensagens. O OPC UA também gravou menos amostras, porque só notifica mudanças (o contador de peças muda a cada 2 s).

Com `OPCUA_SECURITY_MODE=sign_and_encrypt` (Basic256Sha256), a latência média do OPC UA foi de 801 ms, na mesma faixa da conexão sem segurança: nesse volume, o custo da criptografia é desprezível diante do intervalo de publicação, cuja fase relativa às atualizações do servidor varia entre execuções.

## 5. Latência do Tempo Real

`npm run bench:sse` conecta ao SSE como um navegador e mede, para cada amostra, o tempo desde a medição até a chegada ao cliente, por 60 s, com o agrupamento padrão (`LIVE_FLUSH_MS=200`) e sem agrupamento (`LIVE_FLUSH_MS=0`), com as mesmas fontes da Seção 4.

_Tabela 6 – Da medição ao navegador, com LIVE_FLUSH_MS = 200 ms_

| Fonte      | Amostras | Média (ms) | p50 (ms) | p95 (ms) | Máx. (ms) |
| ---------- | -------- | ---------- | -------- | -------- | --------- |
| Simulador  | 240      | 196,9      | 202      | 213      | 216       |
| MQTT       | 240      | 205,6      | 210      | 217      | 219       |
| Modbus TCP | 240      | 173,4      | 200      | 213      | 215       |
| OPC UA     | 201      | 753,1      | 780      | 821      | 826       |

_Tabela 7 – Da medição ao navegador, sem agrupamento (LIVE_FLUSH_MS = 0)_

| Fonte      | Amostras | Média (ms) | p50 (ms) | p95 (ms) | Máx. (ms) |
| ---------- | -------- | ---------- | -------- | -------- | --------- |
| Simulador  | 236      | 1,5        | 1        | 3        | 5         |
| MQTT       | 240      | 4,2        | 3        | 8        | 20        |
| Modbus TCP | 236      | 1,3        | 1        | 2        | 3         |
| OPC UA     | 199      | 946,1      | 945      | 957      | 960       |

Sem agrupamento, uma amostra do simulador ou do Modbus chegou ao navegador em 1 a 2 ms, e uma do MQTT em cerca de 4 ms, já incluindo o broker. Com o agrupamento padrão, a latência subiu para cerca de 200 ms, o tamanho da janela: é o preço de enviar um lote por tag em vez de uma mensagem por amostra, o que protege o navegador quando há muitas tags ou fontes rápidas. Num supervisório, em que o operador acompanha tendências, 200 ms são imperceptíveis; aplicações que precisem de menos podem reduzir a janela. No OPC UA, a latência é dominada pela aquisição (Seção 4).

## 6. Alarmes e Banda Morta

`npm run bench:alarms` passa 24 h do sinal de vazão FIC-301.PV (120 ± 25 m³/h, período de 45 s, ruído de ±1,5 m³/h) pelas mesmas regras do motor de alarmes, com limite alto em 140 m³/h e bandas mortas de 0 a 5% do limite. O sinal ultrapassa o limite uma vez por ciclo (1.920 ciclos), então o ideal é uma ativação por ciclo. Também são contados os episódios de chattering, que a ISA-18.2 define como três ou mais ativações do mesmo alarme em 60 s. O ruído determinístico torna o resultado exatamente reprodutível.

_Tabela 8 – Ativações do alarme H = 140 m³/h, com uma amostra a cada 100 ms_

| Banda morta | Banda (m³/h) | Ativações | Por ciclo | Chattering |
| ----------- | ------------ | --------- | --------- | ---------- |
| 0,0%        | 0,00         | 9.383     | 4,89      | 960        |
| 0,5%        | 0,70         | 5.532     | 2,88      | 954        |
| 1,0%        | 1,40         | 3.071     | 1,60      | 752        |
| 2,0%        | 2,80         | 1.920     | 1,00      | 0          |
| 5,0%        | 7,00         | 1.920     | 1,00      | 0          |

Com amostragem de 100 ms, comum em CLPs e em varreduras Modbus rápidas, o sinal anda menos que a amplitude do ruído entre duas amostras. Sem banda morta, o alarme ativou 9.383 vezes (4,9 por ciclo), com 960 episódios de chattering em 24 h; com banda de 1%, ainda houve 752. A banda padrão de 2% (2,8 m³/h, pouco menos que a amplitude pico a pico do ruído, de 3 m³/h) eliminou o problema: uma ativação por ciclo e nenhum chattering.

_Tabela 9 – Ativações do alarme H = 140 m³/h, com uma amostra por segundo_

| Banda morta | Banda (m³/h) | Ativações | Por ciclo | Chattering |
| ----------- | ------------ | --------- | --------- | ---------- |
| 0,0%        | 0,00         | 1.931     | 1,01      | 11         |
| 0,5%        | 0,70         | 1.924     | 1,00      | 4          |
| 1,0%        | 1,40         | 1.920     | 1,00      | 0          |
| 2,0%        | 2,80         | 1.920     | 1,00      | 0          |
| 5,0%        | 7,00         | 1.920     | 1,00      | 0          |

Com uma amostra por segundo, o sinal anda mais entre duas amostras e o efeito é menor (11 episódios sem banda morta), mas ainda presente. Com o limite em 130 m³/h, onde o sinal cruza o limite mais depressa, não houve chattering a 1 s nem sem banda morta, mas houve a 100 ms (até 1% de banda). Em todos os cenários testados, 2% foi o menor valor que eliminou o chattering, o que justifica o padrão de `ALARM_HYSTERESIS_PCT`.

## 7. Resiliência: Banco Fora do Ar

Com o simulador gerando 100 tags por segundo, o container do banco foi parado por 60 s e religado. Durante a queda, o buffer manteve as amostras e registrou 30 tentativas de gravação com falha (conexão recusada), chegando a 6.000 amostras pendentes; com o banco de volta, gravou 6.200 amostras num único ciclo. Em seguida, `npm run sim:verify` recalculou o valor esperado de cada amostra do período e procurou lacunas na sequência de cada tag:

_Tabela 10 – Conferência das amostras após a queda do banco_

| Medida                             | Valor  |
| ---------------------------------- | ------ |
| Tags do simulador                  | 100    |
| Amostras conferidas (recalculadas) | 14.800 |
| Valores divergentes                | 0      |
| Lacunas (intervalo > 1,5 s)        | 0      |
| Amostras perdidas                  | 0      |
| Gravadas / esperadas               | 98,7%  |

Nenhum valor divergiu e não houve nenhuma lacuna: nenhuma amostra se perdeu nem foi alterada. A relação de 98,7% entre gravadas e esperadas não indica perda: no Windows, o `setInterval` do Node.js disparou em média a cada 1.008,5 ms, e não a cada 1.000 ms (resolução do temporizador do sistema), e por isso o simulador gerou menos amostras que o previsto no período. Os alarmes e o tempo real seguiram funcionando durante a queda, porque recebem as amostras antes do banco.

## 8. Compressão

Ao fim dos experimentos, a tabela `measurements` tinha 1.436.525 linhas, principalmente das tags geradas nos testes de carga. Os chunks foram comprimidos manualmente (`compress_chunk`), o que a política faria depois de 7 dias:

_Tabela 11 – Compressão da hypertable measurements_

| Medida                           | Valor     |
| -------------------------------- | --------- |
| Linhas em measurements           | 1.436.525 |
| Tamanho antes (dados dos chunks) | 203,1 MiB |
| Tamanho depois                   | 20,1 MiB  |
| Economia                         | 90,1%     |
| Razão de compressão              | 10,1 : 1  |

A compressão colunar, com os dados agrupados por tag, reduziu o espaço em 90,1% (razão de 10,1 : 1). Séries de sensores comprimem bem porque valores consecutivos da mesma tag são próximos e os instantes são regulares. Na prática, meses de histórico ocupam uma fração do espaço, e os gráficos de períodos longos consultam os agregados contínuos, sem descomprimir os dados brutos.

## 9. Síntese

- A gravação em lote foi 32 vezes mais rápida que a gravação linha a linha.
- O buffer limitava a ingestão a 5 mil amostras/s, com descarte de amostras acima disso; a causa foi corrigida e validada por testes, e a nova medição sob carga ficou como próximo passo.
- A aquisição por MQTT levou poucos milissegundos; no OPC UA, a latência é a do intervalo de publicação, e a criptografia não a alterou de forma perceptível.
- O tempo real entrega uma amostra ao navegador em 1 a 4 ms sem agrupamento, e em cerca de 200 ms com o agrupamento padrão.
- A banda morta padrão de 2% eliminou o chattering em todos os cenários testados.
- Com o banco fora do ar por 60 s, nenhuma amostra se perdeu.
- A compressão reduziu o espaço em 90%.
