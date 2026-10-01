FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
USER node

ENV HOST=0.0.0.0
EXPOSE 8080
CMD ["node", "src/server.js"]
