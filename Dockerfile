# Ascend Exchange: exchange, ranking and algo competition in one container.
FROM node:22-bookworm-slim

# Python for players' algorithms (numpy/pandas/jsonpickle in a venv the runner finds at /app/.venv)
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN python3 -m venv .venv && .venv/bin/pip install --no-cache-dir numpy pandas jsonpickle

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# data lives on a mounted volume at /app/data; the design comes from the ALGO_DESIGN_B64 secret
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
