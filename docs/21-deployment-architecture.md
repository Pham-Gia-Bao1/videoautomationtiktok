# Deployment Architecture


### 21.1 Topology

```
┌──────────────────────┐
│  Vercel              │  Next.js FE
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  Railway / Fly.io    │  Node.js API + Worker
└──────────┬───────────┘
           │
   ┌───────┼───────────┐
   ▼       ▼           ▼
┌──────┐ ┌─────────┐ ┌──────────┐
│Supabase│ │Redis   │ │Storage   │
└──────┘ └─────────┘ └──────────┘
```

### 21.2 Runtime services

| Service | Vai trò | Scaling |
|---------|---------|---------|
| web | Next.js | Vercel auto |
| api | REST | 1–3 replicas |
| worker-generation | Generation | 1–5 replicas |
| worker-merge | FFmpeg | 1–2 replicas |
| worker-stt | STT | 1–2 replicas |
| redis | BullMQ | managed |

### 21.3 Dockerfile worker

```dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
CMD ["node", "dist/jobs/merge.worker.js"]
```

### 21.4 Observability
- Logs: pino → Loki / Datadog.
- Metrics: Prometheus.
- Tracing: OpenTelemetry (optional).
- Alerts: queue backlog, error rate.

---

