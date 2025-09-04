# MCP Orchestration System 🎯

A production-ready, highly scalable orchestration system for Model Context Protocol (MCP) services with enterprise-grade resilience patterns, service discovery, and workflow automation.

## 🚀 Features

### Core Orchestration
- **Workflow Engine**: YAML/JSON workflow definitions with dependency management
- **Saga Pattern**: Distributed transaction management with compensation logic
- **Parallel Execution**: Intelligent step parallelization with dependency resolution
- **State Management**: Comprehensive workflow and step state tracking

### Resilience & Reliability
- **Circuit Breaker**: Automatic failure detection and recovery
- **Exponential Backoff**: Smart retry logic with jitter
- **Connection Pooling**: Efficient resource management
- **Timeout Protection**: Configurable timeouts at all levels
- **Health Checking**: Continuous MCP health monitoring

### Service Discovery
- **Hot-Reload Registry**: Real-time configuration updates
- **Multiple Discovery Methods**: File, DNS, Environment Variables, Kubernetes
- **Multicast Discovery**: Local development support
- **Auto-Registration**: Dynamic service detection and registration

### Production Ready
- **Comprehensive Monitoring**: Detailed metrics and event tracking  
- **Graceful Shutdown**: Clean resource cleanup
- **Error Recovery**: Automatic compensation and rollback
- **Scalable Architecture**: Handles 100+ concurrent workflows

## 📋 Quick Start

### 1. Installation

```bash
npm install @paestro/orchestrator-mcp
```

### 2. Basic Setup

```javascript
const MCPDiscoveryService = require('./discovery-service');
const { OrchestrationEngine } = require('./orchestration-engine');

// Initialize discovery service
const discoveryService = new MCPDiscoveryService({
  registryPath: './mcp-registry.json',
  environment: 'production'
});

await discoveryService.initialize();

// Initialize orchestration engine
const engine = new OrchestrationEngine(discoveryService, {
  maxConcurrentWorkflows: 50,
  maxConcurrentSteps: 20
});
```

### 3. Define a Workflow

```yaml
# workflow.yaml
name: send_coached_sms
version: "1.0.0"
description: "Send SMS with coach context"
timeout: 180000

steps:
  - name: get_contact
    mcp: google-workspace
    action: get_contact
    params:
      phone: $input.phone
    timeout: 15000
    retries: 2
    
  - name: get_coach_info  
    mcp: main-platform
    action: get_coach
    params:
      coach_id: $input.coach_id
    parallel: true
    
  - name: send_sms
    mcp: textbee
    action: send
    params:
      to: $steps.get_contact.result.phone
      from: $steps.get_coach_info.result.phone
      message: $input.message
    dependsOn: [get_contact, get_coach_info]
    compensation:
      action: send_cancellation_notice
      params:
        to: $steps.get_contact.result.phone
        message: "Previous message cancelled"
```

### 4. Execute Workflow

```javascript
// Load and execute workflow
await engine.loadWorkflowFromFile('./workflow.yaml');

const result = await engine.executeWorkflow('send_coached_sms', {
  phone: '+1234567890',
  coach_id: 'coach-123',
  message: 'Hi! This is your coach.'
});

console.log('Workflow result:', result);
```

## 🏗️ Architecture

### Component Overview

```
┌─────────────────────────────────────────────────────────────┐
│                   Orchestration Engine                     │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────────┐ │
│  │  Workflow   │ │    Saga     │ │     State Machine       │ │  
│  │   Engine    │ │   Pattern   │ │      Manager            │ │
│  └─────────────┘ └─────────────┘ └─────────────────────────┘ │
└─────────────────────┬───────────────────────────────────────┘
                      │
┌─────────────────────┴───────────────────────────────────────┐
│                Discovery Service                            │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────────┐ │
│  │    File     │ │     DNS     │ │      Kubernetes         │ │
│  │   Watcher   │ │  Discovery  │ │      Discovery          │ │
│  └─────────────┘ └─────────────┘ └─────────────────────────┘ │
└─────────────────────┬───────────────────────────────────────┘
                      │
┌─────────────────────┴───────────────────────────────────────┐
│                  MCP Clients                               │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────────┐ │
│  │  Circuit    │ │ Connection  │ │    Request/Response     │ │
│  │  Breaker    │ │    Pool     │ │     Interceptors        │ │
│  └─────────────┘ └─────────────┘ └─────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

```
Workflow Request → Engine → Step Execution → MCP Client → Circuit Breaker → MCP Service
                    ↓
              State Tracking → Event Emission → Monitoring/Logging
                    ↓
              Error Handling → Compensation → Saga Rollback
```

## 📖 Configuration

### MCP Registry (`mcp-registry.json`)

```json
{
  "version": "1.0.0",
  "mcps": {
    "main-platform": {
      "name": "Main Platform MCP",
      "version": "2.0.0",
      "status": "active",
      "priority": 10,
      "endpoints": {
        "primary": {
          "protocol": "http",
          "url": "https://api.paestro.com",
          "headers": {
            "X-API-Key": "${MCP_API_KEY}"
          }
        }
      },
      "capabilities": ["users", "organizations", "communications"],
      "tools": ["get_user", "send_notification"],
      "circuitBreaker": {
        "failureThreshold": 5,
        "resetTimeout": 30000
      },
      "healthCheck": {
        "enabled": true,
        "endpoint": "/health",
        "interval": 30000
      }
    }
  }
}
```

### Environment Configuration

```bash
# MCP Service Endpoints
MCP_API_KEY=your-api-key-here
MAIN_PLATFORM_URL=https://api.paestro.com
TEXTBEE_API_KEY=your-textbee-key

# Discovery Configuration  
NODE_ENV=production
DISCOVERY_METHODS=file,dns,kubernetes
KUBERNETES_NAMESPACE=paestro-mcps

# Engine Configuration
MAX_CONCURRENT_WORKFLOWS=100
MAX_CONCURRENT_STEPS=50
DEFAULT_TIMEOUT=300000
HEALTH_CHECK_INTERVAL=30000
```

## 🔧 Advanced Usage

### Custom Discovery Method

```javascript
class CustomDiscoveryMethod {
  async discoverMcps() {
    // Custom discovery logic
    return {
      'custom-mcp': {
        name: 'Custom MCP',
        version: '1.0.0',
        endpoints: { /* ... */ }
      }
    };
  }
}

discoveryService.addDiscoveryMethod(new CustomDiscoveryMethod());
```

### Request/Response Interceptors

```javascript
const client = new MCPClient(mcpConfig);

// Add logging interceptor
client.addRequestInterceptor(async (request) => {
  console.log('Outgoing request:', request);
});

client.addResponseInterceptor(async (response) => {
  console.log('Incoming response:', response);
});
```

### Custom Compensation Logic

```yaml
steps:
  - name: create_user
    mcp: main-platform
    action: create_user
    params:
      email: $input.email
    compensation:
      mcp: main-platform
      action: delete_user
      params:
        user_id: $steps.create_user.result.id
```

### Conditional Steps

```yaml
steps:
  - name: check_premium
    mcp: main-platform
    action: check_subscription
    params:
      user_id: $input.user_id
      
  - name: premium_feature
    mcp: premium-service
    action: enable_feature
    condition: $steps.check_premium.result.is_premium
    dependsOn: [check_premium]
```

## 📊 Monitoring & Observability

### Event Monitoring

```javascript
engine.on('workflow_started', (context) => {
  console.log(`Workflow started: ${context.workflow.name}`);
});

engine.on('step_failed', (context, step, error) => {
  console.error(`Step failed: ${step.name} - ${error.message}`);
});

engine.on('circuit_breaker_state_change', (state) => {
  console.log(`Circuit breaker state: ${state}`);
});
```

### Metrics Collection

```javascript
// Get comprehensive metrics
const metrics = engine.getMetrics();

console.log('System Metrics:', {
  totalWorkflows: metrics.totalWorkflows,
  activeWorkflows: metrics.activeWorkflows,
  avgExecutionTime: metrics.avgExecutionTime,
  healthyMcpClients: metrics.healthyMcpClients
});
```

### Health Checks

```bash
# Validate registry
npm run registry:validate

# Check system health
npm run health-check

# Get current metrics
npm run metrics
```

## 🐳 Docker Deployment

### Dockerfile

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

### Docker Compose

```yaml
version: '3.8'
services:
  orchestrator:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - MCP_API_KEY=${MCP_API_KEY}
    volumes:
      - ./mcp-registry.json:/app/mcp-registry.json:ro
    restart: unless-stopped
```

## ☸️ Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orchestrator-mcp
spec:
  replicas: 3
  selector:
    matchLabels:
      app: orchestrator-mcp
  template:
    spec:
      containers:
      - name: orchestrator
        image: paestro/orchestrator-mcp:latest
        ports:
        - containerPort: 3000
        env:
        - name: NODE_ENV
          value: "production"
        - name: KUBERNETES_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
        readinessProbe:
          httpGet:
            path: /ready
            port: 3000
          initialDelaySeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: orchestrator-mcp-service
spec:
  selector:
    app: orchestrator-mcp
  ports:
  - port: 80
    targetPort: 3000
  type: LoadBalancer
```

## 🧪 Testing

### Unit Tests

```bash
npm run test:unit
```

### Integration Tests

```bash
npm run test:integration  
```

### Load Testing

```bash
# Test with 100 concurrent workflows
npm run test:load
```

## 🔍 Troubleshooting

### Common Issues

**Circuit Breaker Opening**
```bash
# Check MCP health
curl http://localhost:3000/mcps/main-platform/health

# Reset circuit breaker
curl -X POST http://localhost:3000/mcps/main-platform/circuit-breaker/reset
```

**Workflow Deadlock**
```javascript
// Check workflow status
const status = engine.getWorkflowStatus(workflowId);
console.log('Blocked steps:', status.steps);

// Cancel if necessary  
await engine.cancelWorkflow(workflowId, 'manual_intervention');
```

**Registry Validation Errors**
```bash
# Validate registry syntax
npm run registry:validate

# Check specific MCP configuration
node -e "console.log(JSON.stringify(require('./mcp-registry.json').mcps['main-platform'], null, 2))"
```

## 📚 API Reference

### OrchestrationEngine

#### Methods

- `executeWorkflow(name, input, options)` - Execute workflow
- `registerWorkflow(definition)` - Register workflow definition
- `loadWorkflowFromFile(path)` - Load workflow from YAML/JSON
- `cancelWorkflow(workflowId, reason)` - Cancel running workflow
- `getWorkflowStatus(workflowId)` - Get execution status
- `listActiveExecutions()` - List running workflows
- `getMetrics()` - Get system metrics

#### Events

- `workflow_started` - Workflow execution began
- `workflow_completed` - Workflow finished (success/failure)
- `step_started` - Step execution began
- `step_completed` - Step finished successfully
- `step_failed` - Step failed
- `workflow_compensation_started` - Saga compensation began

### MCPDiscoveryService

#### Methods

- `initialize()` - Start discovery service
- `getMcps()` - Get all discovered MCPs
- `getMcp(name)` - Get specific MCP
- `getMcpsByCapability(capability)` - Find MCPs by capability
- `getMetrics()` - Get discovery metrics

#### Events

- `registry_loaded` - Registry file reloaded
- `mcp_discovered` - New MCP discovered
- `mcp_unhealthy` - MCP failed health check

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Setup

```bash
git clone https://github.com/paestro/orchestrator-mcp.git
cd orchestrator-mcp
npm install
npm run dev
```

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Built for the [Paestro AI Sports Platform](https://paestro.com)
- Inspired by enterprise workflow orchestration patterns
- Uses the Model Context Protocol specification

---

**Made with ❤️ by the Paestro Team**