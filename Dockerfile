# Obraz Puppeteera ma juz Chromium + biblioteki systemowe
FROM ghcr.io/puppeteer/puppeteer:22.12.0

# ffmpeg do eksportu wideo z alfa (MOV ProRes 4444 / WebM)
# Usuwamy repo Google Chrome (wygasly klucz GPG psuje apt-get update); ffmpeg jest w Debian main.
USER root
RUN rm -f /etc/apt/sources.list.d/*chrome* /etc/apt/sources.list.d/*google* 2>/dev/null; apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
RUN chown -R pptruser:pptruser /app
USER pptruser

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
