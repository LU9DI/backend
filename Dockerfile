# API Filtra.IA — imagem slim (sem g++/python: bcryptjs puro)
FROM node:20-bookworm-slim

WORKDIR /app

# Copia manifests primeiro para cache de camadas
COPY package.json package-lock.json* ./

# Produção: sem devDependencies (sqlite/sqlite3 ficam de fora)
RUN npm install --omit=dev --no-audit --no-fund \
  && npm cache clean --force

COPY . .

ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000

CMD ["npm", "start"]
