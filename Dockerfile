# Railway / Docker — API Filtra.IA
FROM node:20-bookworm-slim

WORKDIR /app

# O runtime de produção usa Postgres e bcryptjs (JS puro), portanto não
# precisa de toolchain nativa para bcrypt/sqlite3.
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .

ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000

CMD ["npm", "start"]
