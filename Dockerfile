# Dockerfile for running the Cloud IDE server
FROM node:18-slim

RUN apt-get update && apt-get install -y ca-certificates curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package.json
RUN npm install --production
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
