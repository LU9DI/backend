# API Filtra.IA — Node + Chromium (Puppeteer PDF)
FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./

# tsx já é dependência de produção; não instalar novamente após npm ci.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi

COPY . .

ENV NODE_ENV=production
ENV PORT=5000
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=1
ENV ACQUISITION_BROWSER_BOT=0

EXPOSE 5000

CMD ["npm", "start"]
