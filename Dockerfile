# Obraz Puppeteera ma już Chromium + biblioteki systemowe
FROM ghcr.io/puppeteer/puppeteer:22.12.0

# ffmpeg do eksportu wideo z alfą (MOV ProRes 4444 / WebM)
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
RUN chown -R pptruser:pptruser /app
USER pptruser

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
