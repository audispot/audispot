FROM node:18-alpine

WORKDIR /app

# Copy dependency configuration files
COPY package*.json ./

# Cloud Build will read package.json and install routeros-client automatically here
RUN npm install --only=production

# Copy server code
COPY . .

EXPOSE 8080

CMD ["node", "server.js"]