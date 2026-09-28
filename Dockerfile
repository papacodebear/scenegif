# Debian, not Alpine: onnxruntime-node ships glibc-only binaries
FROM node:24-bookworm-slim

ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

# Debian's packaged yt-dlp is too stale for YouTube; use the upstream zipapp
ADD --chmod=755 https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp /usr/local/bin/yt-dlp

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
