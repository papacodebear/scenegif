FROM node:24-alpine

ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA

RUN apk add --no-cache ffmpeg yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

# Download and cache MiniLM-L6-v2 ONNX weights at build time
RUN node src/cache-model.js

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/app.js"]
