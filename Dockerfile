FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && npm install --omit=dev && apt-get purge -y python3 make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY server.js ./
ENV PORT=8080 DB_PATH=/data/talk.db
VOLUME /data
EXPOSE 8080
CMD ["node", "server.js"]
