FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src
COPY openapi ./openapi
COPY public ./public

EXPOSE 3000 3001 3002 3003
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3000}/health || exit 1

USER node
CMD ["node", "src/index.js"]
