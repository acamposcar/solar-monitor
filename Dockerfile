FROM node:24.22.1-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY --chown=node:node monitor.js ./
USER node

CMD ["node", "monitor.js"]
