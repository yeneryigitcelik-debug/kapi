# kapı — KVKK-first yerel LLM gateway
FROM node:20-alpine

WORKDIR /app

# Önce manifest + lockfile → katman önbelleği. Tek runtime dep (yaml) kurulur.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Kaynak (yalnız çalışma için gerekenler).
COPY bin ./bin
COPY src ./src
COPY kapi.example.yaml ./

EXPOSE 4100

# Yapılandırmayı dışarıdan mount et:
#   -v "$PWD/kapi.yaml:/app/kapi.yaml:ro"
# Görüntünün varsayılanı KVKK-first 127.0.0.1'dir; konteyner dışından erişmek için
# çalışırken bilinçli olarak --host 0.0.0.0 geç ve host portunu loopback'e bağla:
#   docker run -p 127.0.0.1:4100:4100 ... kapi up --host 0.0.0.0
ENTRYPOINT ["node", "bin/kapi.js"]
CMD ["up"]
