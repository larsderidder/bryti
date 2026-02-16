# Stage 1: Build
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Stage 2: Runtime
FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Create non-root user
RUN addgroup -g 1000 -S pibot && \
    adduser -u 1000 -S pibot -G pibot
USER pibot

# Data directory is a volume mount
VOLUME /data
ENV PIBOT_DATA_DIR=/data

CMD ["node", "dist/index.js"]
