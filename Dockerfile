# Railway / Docker — API Filtra.IA
FROM node:20-bookworm-slim

WORKDIR /app

# Dependências de build do bcrypt/sqlite3 + Python/ReportLab para PDFs mensais
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-reportlab make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
# Sem package-lock: npm install (não npm ci)
RUN npm install --omit=dev && npm cache clean --force

COPY . .

ENV NODE_ENV=production
ENV PORT=5000
ENV PYTHON_BIN=python3

EXPOSE 5000

CMD ["npm", "start"]
