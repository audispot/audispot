# Use the official stable Node 22 slim image
FROM node:22-slim

# Create application directory
WORKDIR /usr/src/app

# Copy dependency manifests
COPY package*.json ./

# Install dependencies cleanly (it will automatically use npm install if lockfile is missing)
RUN npm install --omit=dev

# Copy all application files
COPY . .

# Expose the Cloud Run dynamic PORT env variable
EXPOSE 8080

# Run the backend application
CMD [ "npm", "start" ]