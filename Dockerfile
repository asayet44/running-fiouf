FROM node:22-slim
# Claude Code écrit l'avis du coach (claude -p)
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force
WORKDIR /app
COPY package.json server.js ./
ENV PORT=3000 USERS_FILE=/config/users.json DATA_DIR=/data HOME=/data/home
EXPOSE 3000
CMD ["sh", "-c", "mkdir -p \"$HOME\" && exec node server.js"]
