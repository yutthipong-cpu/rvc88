FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/store
# No npm dependencies: copy the site and the server as they are.
COPY server.js index.html app.js styles.css package.json ./
COPY assets ./assets
COPY data/staff.json ./data/staff.json
RUN mkdir -p /app/store && chown -R node:node /app/store
USER node
EXPOSE 3000
CMD ["node", "server.js"]
