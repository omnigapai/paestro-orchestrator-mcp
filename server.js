const http = require('http');
const MCPDiscoveryService = require('./discovery-service');
const { OrchestrationEngine } = require('./orchestration-engine');
const path = require('path');

const PORT = process.env.PORT || 3000;

class OrchestratorServer {
  constructor() {
    this.discoveryService = null;
    this.orchestrationEngine = null;
    this.logger = console;
    this.server = null;
  }

  async initialize() {
    try {
      this.logger.info('🚀 Initializing MCP Orchestrator Server...');

      // Initialize Discovery Service
      this.discoveryService = new MCPDiscoveryService({
        registryPath: path.join(__dirname, 'mcp-registry.json'),
        environment: process.env.NODE_ENV || 'production',
        logger: this.logger
      });

      await this.discoveryService.initialize();
      this.logger.info('✅ Discovery Service initialized');

      // Initialize Orchestration Engine
      this.orchestrationEngine = new OrchestrationEngine(this.discoveryService, {
        maxConcurrentWorkflows: 100,
        maxConcurrentSteps: 50,
        logger: this.logger
      });

      this.logger.info('✅ Orchestration Engine initialized');
      return true;
    } catch (error) {
      this.logger.error('❌ Failed to initialize:', error);
      throw error;
    }
  }

  async handleRequest(req, res) {
    const setJsonResponse = () => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
    };

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      setJsonResponse();
      res.writeHead(200);
      res.end();
      return;
    }

    setJsonResponse();

    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const pathname = url.pathname;
      const method = req.method;

      // Health check endpoint
      if (pathname === '/health' && method === 'GET') {
        const mcps = await this.discoveryService.listMCPs();
        const health = {
          status: 'healthy',
          timestamp: new Date().toISOString(),
          environment: process.env.NODE_ENV || 'production',
          port: PORT,
          mcps: {
            total: Object.keys(mcps).length,
            active: Object.values(mcps).filter(m => m.status === 'active').length,
            failed: Object.values(mcps).filter(m => m.status === 'failed').length
          }
        };
        res.writeHead(200);
        res.end(JSON.stringify(health));
        return;
      }

      // MCP discovery endpoint
      if (pathname === '/api/mcps' && method === 'GET') {
        const mcps = await this.discoveryService.listMCPs();
        res.writeHead(200);
        res.end(JSON.stringify(mcps));
        return;
      }

      // Route to appropriate MCP based on capability
      if (pathname.startsWith('/api/')) {
        const body = await this.getRequestBody(req);
        const pathSegments = pathname.split('/').filter(s => s);
        
        // Determine capability from path
        let capability = null;
        if (pathSegments[1]) {
          capability = pathSegments[1]; // e.g., /api/users -> users
        }

        // Find MCP for this capability
        const mcp = await this.discoveryService.findMCPByCapability(capability);
        if (!mcp) {
          res.writeHead(404);
          res.end(JSON.stringify({ 
            error: `No MCP found for capability: ${capability}`,
            availableCapabilities: await this.discoveryService.getAvailableCapabilities()
          }));
          return;
        }

        // Forward request to MCP
        const result = await this.forwardToMCP(mcp, pathname, method, body, req.headers);
        res.writeHead(result.status || 200);
        res.end(JSON.stringify(result.data));
        return;
      }

      // Root endpoint
      if (pathname === '/' && method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({
          service: 'Paestro MCP Orchestrator',
          version: '1.0.0',
          status: 'running',
          endpoints: {
            health: '/health',
            mcps: '/api/mcps',
            api: '/api/*'
          }
        }));
        return;
      }

      // 404 for unknown routes
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Route not found' }));

    } catch (error) {
      this.logger.error('Request error:', error);
      res.writeHead(500);
      res.end(JSON.stringify({ 
        error: 'Internal server error', 
        message: error.message 
      }));
    }
  }

  async getRequestBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : null);
        } catch (e) {
          resolve(body);
        }
      });
      req.on('error', reject);
    });
  }

  async forwardToMCP(mcp, pathname, method, body, headers) {
    const fetch = require('node-fetch');
    
    try {
      const url = `${mcp.url}${pathname}`;
      const options = {
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': headers['x-api-key'] || process.env.MCP_API_KEY
        }
      };

      if (body && method !== 'GET') {
        options.body = JSON.stringify(body);
      }

      const response = await fetch(url, options);
      const data = await response.json();

      return {
        status: response.status,
        data
      };
    } catch (error) {
      this.logger.error(`Failed to forward to MCP ${mcp.name}:`, error);
      throw error;
    }
  }

  async start() {
    await this.initialize();

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    this.server.listen(PORT, () => {
      this.logger.info(`✅ MCP Orchestrator Server running on port ${PORT}`);
      this.logger.info(`🌐 Health check: http://localhost:${PORT}/health`);
      this.logger.info(`🔍 MCP discovery: http://localhost:${PORT}/api/mcps`);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());
  }

  async shutdown() {
    this.logger.info('🛑 Shutting down server...');
    if (this.server) {
      this.server.close();
    }
    if (this.discoveryService) {
      await this.discoveryService.stop();
    }
    process.exit(0);
  }
}

// Start the server
if (require.main === module) {
  const server = new OrchestratorServer();
  server.start().catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}

module.exports = OrchestratorServer;