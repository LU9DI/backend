# API Filtra.IA — produção
FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5000

# sqlite3 nativo precisa das libs em runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY . .

# Persistência do SQLite (monte volume em /data no Railway)
RUN mkdir -p /data
ENV SQLITE_DB_PATH=/data/database.sqlite

EXPOSE 5000

# tsx em produção (mesmo runtime do dev, sem build separado)
CMD ["npx", "tsx", "server.ts"]
