FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && install -d -m 700 -o node -g node /app/data
COPY server.mjs storage.mjs views.mjs app.js style.css ./
ENV NODE_ENV=production FILE_REQUEST_BIND=0.0.0.0 FILE_REQUEST_DATA=/app/data PORT=3000
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
