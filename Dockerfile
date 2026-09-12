# API Filtra.IA — slim + Chromium para relatórios HTML/CSS
FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-noto-cjk ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./

RUN npm install --omit=dev --no-audit --no-fund \
  && npm cache clean --force

COPY . .

ENV NODE_ENV=production
ENV PORT=5000
ENV CHROMIUM_PATH=/usr/bin/chromium

EXPOSE 5000

CMD ["npm", "start"]
