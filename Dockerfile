# Imagem da API TALOS (backend + dashboard).
#
#   docker compose --profile app up -d --build
#
# Duas etapas: a primeira compila o TypeScript (com as dependências de
# desenvolvimento); a segunda leva só o JavaScript compilado, o dashboard e as
# dependências de produção.

# ---- build ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ---- execução ----
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public
# Pasta dos certificados do cliente OPC UA (OPCUA_PKI_DIR), gravável pelo
# usuário sem privilégios que roda a API.
RUN mkdir -p .opcua-pki && chown node:node .opcua-pki
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health > /dev/null || exit 1
CMD ["node", "dist/main.js"]
