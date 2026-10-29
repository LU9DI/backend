# API Filtra.IA — Node
FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./

# Preserve npm's layer cache; do not clean it in the same build layer.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV ACQUISITION_BROWSER_BOT=0

EXPOSE 3000

CMD ["npm", "start"]
