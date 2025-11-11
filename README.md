# Pubky AI Bot

AI-powered bot for the Pubky decentralized social network. Automatically responds to mentions with intelligent summaries and fact-checking.

## Quick Start with Docker Compose

**1. Clone and setup environment:**
```bash
git clone <repository-url>
cd jeb-bot
cp .env.example .env
```

**2. Edit `.env` and add your required configuration:**
```bash
# Required: Bot authentication (generate at https://iancoleman.io/bip39/)
PUBKY_BOT_MNEMONIC="word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12"

# Required: AI provider (Groq is free for development)
AI_PRIMARY_PROVIDER=groq
GROQ_API_KEY=gsk_your_groq_key_here

# Optional: Brave Search API for fact-checking
BRAVE_API_KEY=your_brave_api_key
```

**3. Start all services:**
```bash
docker compose up -d
```

**4. Check logs:**
```bash
docker compose logs -f pubky-ai-bot
```

**5. Stop services:**
```bash
docker compose down
```


## Architecture

```
Mentions → Poller → Router → Action Workers → Reply Publisher
                     ↓
               Heuristics/LLM Classification
                     ↓
            Summary Worker | Factcheck Worker
                     ↓
              AI Generation | MCP Search + AI
                     ↓
                Safety Check + Reply
```

## Configuration

### Required Environment Variables

```env
# Bot Authentication
PUBKY_BOT_MNEMONIC="your 12-24 word mnemonic"

# AI Provider
AI_PRIMARY_PROVIDER=groq  # or: openai, anthropic, openrouter
GROQ_API_KEY=gsk_...      # Get from: https://console.groq.com
```

### Optional Environment Variables

```env
# Network (default: testnet)
PUBKY_NETWORK=testnet

# AI Configuration
AI_MODEL_SUMMARY=llama-3.1-8b-instant
AI_MODEL_FACTCHECK=llama-3.1-8b-instant
AI_MODEL_CLASSIFIER=llama-3.1-8b-instant

# Brave Search (for fact-checking)
BRAVE_API_KEY=your_key

# Database (only if not using Docker Compose)
DATABASE_URL=postgres://user:pass@localhost:5432/pubkybot
REDIS_URL=redis://localhost:6379/0
```

See `.env.example` for complete configuration options.

## Development

### Local Development (without Docker)

```bash
# Install dependencies
npm ci

# Run database migrations
npm run db:migrate

# Start development server
npm run dev
```

### Production Deployment

```bash
# Build
npm run build

# Start all services
docker compose -f docker-compose.yml up -d

# Or run components separately for horizontal scaling
npm start  # Start poller + router (single instance)
NODE_ENV=production WORKER_TYPE=summary npm start     # Scale these
NODE_ENV=production WORKER_TYPE=factcheck npm start   # horizontally
```

## API Endpoints

- **Health**: `GET /api/health` - Comprehensive health check
- **Readiness**: `GET /api/health/ready` - Kubernetes readiness probe
- **Liveness**: `GET /api/health/live` - Kubernetes liveness probe
- **Metrics**: `GET /metrics` - Prometheus metrics

## Configuration

Configuration uses `node-config` with environment-specific overrides:

- `config/default.json` - Base configuration
- `config/development.json` - Development overrides
- `config/production.json` - Production overrides
- `config/test.json` - Test overrides

Key configuration sections:

- **Features**: Enable/disable summary, factcheck, translate, image actions
- **AI Models**: Configure providers, models, token limits, temperature
- **MCP Integration**: Brave search configuration and timeouts
- **Safety**: Wordlist configuration and blocking behavior
- **Limits**: Concurrency, timeouts, rate limiting

## Actions

### Summary Action

**Triggers**: Keywords like "summary", "tl;dr", "recap" or LLM classification

**Process**:
1. Build thread context from Pubky posts
2. Generate summary using AI with token budgets
3. Extract key points and format reply
4. Safety check and publish response

**Output**: Brief summary + up to 3 key bullet points

### Factcheck Action

**Triggers**: Keywords like "verify", "fact check", "source?" or LLM classification

**Process**:
1. Extract factual claims from content
2. Use MCP tools to search for evidence via Brave API
3. AI analyzes sources and assigns verdict per claim
4. Combine into overall assessment with confidence

**Output**: Verdict (accurate/mixed/inaccurate/unverifiable) + top 2-3 sources


## Architecture Details

### Event Flow

1. **Polling**: `MentionPoller` fetches mentions from Pubky homeserver
2. **Ingestion**: Mentions stored in DB, `mention.received.v1` events emitted
3. **Routing**: `Router` classifies intent (heuristics → LLM) and emits action events
4. **Processing**: Action workers consume events, execute logic, publish replies
5. **Publishing**: Replies sent via Pubky SDK and stored for audit

### Database Schema

- **mentions**: Raw mention ingestion and processing state
- **action_executions**: Action execution tracking with metrics
- **artifacts**: Stored outputs (summaries, evidence, sources)
- **replies**: Published replies for auditability
- **routing_decisions**: Intent classification audit trail

### Redis Streams

- Event buses: `pubky:mention_received`, `pubky:action_summary_requested`, etc.
- Consumer groups: `router`, `summary-workers`, `factcheck-workers`
- Dead letter queue: `pubky:dlq` for failed message handling

### Idempotency

All operations use idempotency keys:
- Mention ingestion: `mention:{mentionId}`
- Routing decisions: `route:{mentionId}`
- Action execution: `action:{actionType}:{mentionId}`

TTL: 24 hours (configurable)

### Safety & Error Handling

- **Wordlist Safety**: Configurable banned terms with blocking
- **Timeouts**: Configurable per-operation timeouts with retries
- **Error Storage**: Failed operations stored with context
- **DLQ Processing**: Failed messages moved to dead letter queue
- **Circuit Breaking**: Graceful degradation on service failures

