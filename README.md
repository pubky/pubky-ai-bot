# Grok Bot v2 - Action-Centric Architecture

A modern, scalable Pubky bot with PostgreSQL, Redis Streams, AI classification, and MCP integration for factchecking and summarization.

## Features

- **Action-Centric Architecture**: Uniform workers consume action-specific events
- **AI-Powered Classification**: Heuristics + LLM routing for intent detection
- **Summary Generation**: Thread summarization with key points extraction
- **Fact Checking**: Claim verification using MCP integration with Brave search
- **Event-Driven**: Redis Streams for reliable message processing
- **Idempotent**: Built-in idempotency for safe operation
- **Observable**: Prometheus metrics and comprehensive health checks
- **Safe**: Configurable safety wordlist and content filtering

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

## Tech Stack

- **Runtime**: Node.js 20+, TypeScript
- **Database**: PostgreSQL (primary) + Redis (events/cache)
- **AI**: Vercel AI SDK with OpenAI/Anthropic providers
- **Search**: MCP integration with Brave Search API
- **Events**: Redis Streams for reliable message processing
- **Monitoring**: Prometheus metrics, Winston logging
- **Validation**: Zod schemas, comprehensive type safety

## Getting Started

### Prerequisites

- Node.js >= 20
- npm >= 9
- Redis >= 6 with Streams
- PostgreSQL >= 14
- Pubky credentials (bot secret key and homeserver URL)
- Optional: Anthropic or OpenAI API key
- Optional: MCP Brave server running on HTTP

### Environment Setup

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Required variables:
```env
NODE_ENV=development
DATABASE_URL=postgres://user:pass@localhost:5432/grokbot
REDIS_URL=redis://localhost:6379/0
PUBKY_HOMESERVER_URL=https://homeserver.example
PUBKY_BOT_SECRET_KEY=your-secret-or-mnemonic
ANTHROPIC_API_KEY=sk-ant-...
BRAVE_MCP_BASE_URL=http://localhost:8921
```

### Installation

```bash
# Install dependencies
npm ci

# Install AI SDK provider (choose one)
npm i ai @ai-sdk/anthropic
# OR
npm i ai @ai-sdk/openai

# Install MCP client
npm i @ai-sdk/mcp

# Run database migrations
npm run db:migrate

# Start development server
npm run dev
```

### Production Deployment

For production, run components separately:

```bash
# Build
npm run build

# Start poller + router (single instance)
npm start

# Start workers (multiple instances)
NODE_ENV=production WORKER_TYPE=summary npm start
NODE_ENV=production WORKER_TYPE=factcheck npm start
```

All processes share Redis and PostgreSQL. Scale workers horizontally by running multiple instances.

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

## Development

### Scripts

```bash
npm run dev          # Development server with hot reload
npm run build        # Compile TypeScript to dist/
npm start           # Run compiled server
npm run db:migrate  # Run database migrations
npm test            # Run test suite
npm run test:watch  # Run tests in watch mode
npm run lint        # ESLint check
npm run lint:fix    # Fix ESLint issues
npm run format      # Format code with Prettier
npm run typecheck   # TypeScript type checking
```

### Testing

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Watch mode for development
npm run test:watch
```

### Code Quality

The project enforces code quality through:

- **TypeScript**: Strict mode with comprehensive type checking
- **ESLint**: Code linting with TypeScript rules
- **Prettier**: Consistent code formatting
- **Jest**: Unit and integration testing

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

- Event buses: `grok:mention_received`, `grok:action_summary_requested`, etc.
- Consumer groups: `router`, `summary-workers`, `factcheck-workers`
- Dead letter queue: `grok:dlq` for failed message handling

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

## Monitoring & Observability

### Metrics (Prometheus)

- `grok_mentions_total{status}` - Mentions processed
- `grok_actions_total{action,status}` - Actions executed
- `grok_replies_total{action}` - Replies published
- `grok_action_duration_seconds{action}` - Action execution time
- `grok_llm_duration_seconds{kind}` - LLM request latency
- `grok_mcp_duration_seconds{tool}` - MCP tool latency

### Logging

Structured JSON logging with:
- **Request IDs**: Correlation across operations
- **Context**: mentionId, actionId, eventId for tracing
- **Levels**: debug, info, warn, error with appropriate detail
- **Performance**: Duration tracking for all major operations

### Health Checks

- **Application**: Individual service health status
- **Dependencies**: Database, Redis, MCP client connectivity
- **Workers**: Action worker availability and processing capability
- **Kubernetes**: Separate liveness/readiness endpoints

## Production Considerations

### Scaling

- **Horizontal**: Run multiple worker instances per action type
- **Vertical**: Increase concurrency limits and timeouts
- **Database**: Connection pooling with configurable pool sizes
- **Redis**: Clustering for high availability

### Security

- **Secrets**: Environment variables only, never committed
- **Safety**: Comprehensive content filtering before publishing
- **Rate Limiting**: Built-in sliding window rate limiting (optional)
- **Input Validation**: Zod schemas for all configuration and data

### Deployment

- **Docker**: Multi-stage builds for optimized images
- **Kubernetes**: Health checks, resource limits, HPA support
- **CI/CD**: Automated testing, linting, security scanning
- **Monitoring**: Grafana dashboards, alerting rules

## Roadmap

**Phase 1 (Current)**: Summary + Factcheck actions with MCP integration
**Phase 2**: Translation action, evidence API, improved caching
**Phase 3**: Image generation action, advanced safety, streaming

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Run tests: `npm test`
4. Run linting: `npm run lint`
5. Commit changes: `git commit -m 'Add amazing feature'`
6. Push to branch: `git push origin feature/amazing-feature`
7. Open a Pull Request

## License

MIT License - see LICENSE file for details.