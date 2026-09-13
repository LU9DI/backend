# API Filtra.IA — Node + Python ReportLab + Chromium fallback
FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    chromium fonts-noto-cjk ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY requirements-pdf.txt ./

RUN npm install --omit=dev --no-audit --no-fund \
  && npm cache clean --force \
  && pip3 install --no-cache-dir --break-system-packages -r requirements-pdf.txt

COPY . .

ENV NODE_ENV=production
ENV PORT=5000
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV PYTHON_PATH=/usr/bin/python3

EXPOSE 5000

CMD ["npm", "start"]
