# API Filtra.IA — slim (sem g++/python: bcryptjs puro JS)
FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm install --omit=dev --no-audit --no-fund \
  && npm cache clean --force

COPY . .

ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000

CMD ["npm", "start"]
