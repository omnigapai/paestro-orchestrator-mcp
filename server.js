const http = require('http');
const { Server } = require('socket.io');
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
    this.io = null;
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
      
      // Enhanced request debugging
      this.logger.info(`🌐 Incoming ${method} ${req.url}`);
      this.logger.info(`   Pathname: ${pathname}`);
      this.logger.info(`   Query params: ${url.search || '(none)'}`);
      if (url.searchParams.size > 0) {
        for (const [key, value] of url.searchParams) {
          this.logger.info(`   - ${key}: ${value}`);
        }
      }

      // Health check endpoint
      if (pathname === '/health' && method === 'GET') {
        const mcps = this.discoveryService.getMcps();
        const health = {
          status: 'healthy',
          timestamp: new Date().toISOString(),
          environment: process.env.NODE_ENV || 'production',
          port: PORT,
          mcps: {
            total: mcps.length,
            active: mcps.filter(m => m.status === 'active').length,
            failed: mcps.filter(m => m.status === 'failed').length
          }
        };
        res.writeHead(200);
        res.end(JSON.stringify(health));
        return;
      }

      // MCP discovery endpoint
      if (pathname === '/api/mcps' && method === 'GET') {
        const mcps = this.discoveryService.getMcps();
        res.writeHead(200);
        res.end(JSON.stringify(mcps));
        return;
      }

      // Google OAuth connection initiation - Forward with original query parameters
      if (pathname === '/calendar/google/connect' && method === 'GET') {
        const coachId = url.searchParams.get('coachId');
        const redirectUri = url.searchParams.get('redirect_uri') || 'http://localhost:8080/calendar-integration';
        
        if (!coachId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'coachId parameter is required' }));
          return;
        }

        try {
          const googleWorkspaceMcp = this.discoveryService.getMcp('google-workspace');
          if (!googleWorkspaceMcp || googleWorkspaceMcp.status !== 'active') {
            // Provide mock OAuth URL if Google Workspace MCP is not available
            const mockOAuthUrl = `https://accounts.google.com/oauth2/authorize?client_id=mock&redirect_uri=${encodeURIComponent(redirectUri)}&scope=https://www.googleapis.com/auth/calendar&response_type=code&state=${coachId}`;
            res.writeHead(200);
            res.end(JSON.stringify({ 
              oauth_url: mockOAuthUrl,
              status: 'mock_mode',
              message: 'Google Workspace MCP not available, using mock response'
            }));
            return;
          }

          // Forward to the Google MCP's oauth-url endpoint instead of the calendar/google/connect path
          const result = await this.forwardToMCP(
            googleWorkspaceMcp, 
            '/google/oauth-url',  // Use Google MCP's actual endpoint
            method,   // Forward original method (GET)
            null,     // No body for GET request
            req.headers
          );
          
          // If MCP returns 404 or other error, fall back to mock mode
          if (result.status === 404 || result.status >= 400) {
            const mockOAuthUrl = `https://accounts.google.com/oauth2/authorize?client_id=mock&redirect_uri=${encodeURIComponent(redirectUri)}&scope=https://www.googleapis.com/auth/calendar&response_type=code&state=${coachId}`;
            res.writeHead(200);
            res.end(JSON.stringify({ 
              oauth_url: mockOAuthUrl,
              status: 'mock_mode',
              message: `Google Workspace MCP route not found (${result.status}), using mock response`,
              mcp_response: result.data
            }));
            return;
          }
          
          res.writeHead(result.status || 200);
          res.end(JSON.stringify(result.data));
        } catch (error) {
          this.logger.error('Google OAuth connect error:', error);
          res.writeHead(500);
          res.end(JSON.stringify({ 
            error: 'Failed to initiate OAuth connection',
            message: error.message 
          }));
        }
        return;
      }

      // Check Google OAuth status for coach
      if (pathname.match(/^\/coach\/[^/]+\/google-oauth-status$/) && method === 'GET') {
        const coachId = pathname.split('/')[2];
        
        try {
          const googleWorkspaceMcp = this.discoveryService.getMcp('google-workspace');
          if (!googleWorkspaceMcp || googleWorkspaceMcp.status !== 'active') {
            // Provide mock status if Google Workspace MCP is not available
            res.writeHead(200);
            res.end(JSON.stringify({ 
              connected: false,
              status: 'mock_mode',
              last_sync: null,
              scopes: [],
              message: 'Google Workspace MCP not available, using mock response'
            }));
            return;
          }

          const result = await this.forwardToMCP(
            googleWorkspaceMcp, 
            `/coach/${coachId}/google-oauth-status`,
            'GET',
            null,
            req.headers
          );
          
          // If MCP returns 404 or other error, fall back to mock mode
          if (result.status === 404 || result.status >= 400) {
            res.writeHead(200);
            res.end(JSON.stringify({ 
              connected: false,
              status: 'mock_mode',
              last_sync: null,
              scopes: [],
              message: `Google Workspace MCP route not found (${result.status}), using mock response`,
              mcp_response: result.data
            }));
            return;
          }
          
          res.writeHead(result.status || 200);
          res.end(JSON.stringify(result.data));
        } catch (error) {
          this.logger.error('Google OAuth status error:', error);
          res.writeHead(500);
          res.end(JSON.stringify({ 
            error: 'Failed to check OAuth status',
            message: error.message 
          }));
        }
        return;
      }

      // Get calendar events
      if (pathname === '/calendar/events' && method === 'GET') {
        const coachId = url.searchParams.get('coachId');
        const startDate = url.searchParams.get('start_date');
        const endDate = url.searchParams.get('end_date');
        const maxResults = url.searchParams.get('max_results') || '50';
        
        if (!coachId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'coachId parameter is required' }));
          return;
        }

        try {
          const googleWorkspaceMcp = this.discoveryService.getMcp('google-workspace');
          if (!googleWorkspaceMcp || googleWorkspaceMcp.status !== 'active') {
            // Return empty events array if Google Workspace MCP is not available
            const emptyResponse = {
              events: [],
              status: 'fallback_mode',
              message: 'Google Workspace MCP not available, returning empty events'
            };
            res.writeHead(200);
            res.end(JSON.stringify(emptyResponse));
            return;
          }

          const queryParams = new URLSearchParams({
            coachId,
            ...(startDate && { start_date: startDate }),
            ...(endDate && { end_date: endDate }),
            max_results: maxResults
          });

          const result = await this.forwardToMCP(
            googleWorkspaceMcp, 
            `/calendar/events?${queryParams.toString()}`,
            'GET',
            null,
            req.headers
          );
          
          // If MCP returns 404 or other error, fall back to empty events
          if (result.status === 404 || result.status >= 400) {
            const emptyResponse = {
              events: [],
              status: 'fallback_mode',
              message: `Google Workspace MCP route not found (${result.status}), returning empty events`,
              mcp_response: result.data
            };
            res.writeHead(200);
            res.end(JSON.stringify(emptyResponse));
            return;
          }
          
          res.writeHead(result.status || 200);
          res.end(JSON.stringify(result.data));
        } catch (error) {
          this.logger.error('Calendar events error:', error);
          // Fallback to empty events array on any error
          const emptyResponse = {
            events: [],
            status: 'fallback_mode',
            message: 'Google Workspace MCP connection failed, returning empty events',
            error: error.message
          };
          res.writeHead(200);
          res.end(JSON.stringify(emptyResponse));
        }
        return;
      }

      // OAuth token exchange endpoint - Handle authorization code exchange
      if (pathname === '/oauth/exchange' && method === 'POST') {
        const body = await this.getRequestBody(req);
        const { code, coachId, coachEmail, state } = body;
        
        if (!code || !coachId) {
          res.writeHead(400);
          res.end(JSON.stringify({ 
            success: false,
            error: 'Missing authorization code or coachId' 
          }));
          return;
        }

        try {
          const googleWorkspaceMcp = this.discoveryService.getMcp('google-workspace');
          if (!googleWorkspaceMcp || googleWorkspaceMcp.status !== 'active') {
            res.writeHead(200);
            res.end(JSON.stringify({ 
              success: false,
              error: 'Google Workspace MCP not available',
              status: 'mock_mode'
            }));
            return;
          }

          // Forward the token exchange to Google Workspace MCP
          const result = await this.forwardToMCP(
            googleWorkspaceMcp, 
            '/oauth/exchange',
            'POST',
            { code, coachId, coachEmail, state },
            req.headers
          );
          
          // Return the result from the Google MCP
          res.writeHead(result.status || 200);
          res.end(JSON.stringify(result.data));
        } catch (error) {
          this.logger.error('OAuth token exchange error:', error);
          res.writeHead(500);
          res.end(JSON.stringify({ 
            success: false,
            error: 'Failed to exchange OAuth token',
            message: error.message 
          }));
        }
        return;
      }

      // Route to appropriate MCP based on path patterns
      if (pathname !== '/' && pathname !== '/health' && pathname !== '/api/mcps') {
        const body = await this.getRequestBody(req);
        
        // Try to match route patterns from registry
        const registry = this.discoveryService.registry;
        let targetMcp = null;
        
        // Check routing patterns
        if (registry.routing_rules && registry.routing_rules.patterns) {
          for (const [pattern, capabilities] of Object.entries(registry.routing_rules.patterns)) {
            const regex = new RegExp(pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]+'));
            if (regex.test(pathname)) {
              // Find first available MCP with this capability
              for (const cap of capabilities) {
                const mcps = this.discoveryService.getMcpsByCapability(cap);
                if (mcps.length > 0) {
                  targetMcp = mcps[0];
                  break;
                }
              }
              if (targetMcp) break;
            }
          }
        }
        
        // Default: route to main-platform if no pattern matches
        if (!targetMcp) {
          targetMcp = this.discoveryService.getMcp('main-platform') || 
                      this.discoveryService.getMcps()[0];
        }

        if (!targetMcp) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'No MCPs available' }));
          return;
        }

        // Forward request to MCP with full URL (including query params)
        const result = await this.forwardToMCP(targetMcp, req.url, method, body, req.headers);
        
        // Set response headers if provided
        if (result.headers) {
          Object.entries(result.headers).forEach(([key, value]) => {
            if (!['content-length', 'transfer-encoding'].includes(key.toLowerCase())) {
              res.setHeader(key, value);
            }
          });
        }
        
        res.writeHead(result.status || 200);
        
        // Handle different response types
        if (typeof result.data === 'string') {
          res.end(result.data);
        } else {
          res.end(JSON.stringify(result.data));
        }
        return;
      }

      // Root endpoint
      if (pathname === '/' && method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({
          service: 'Paestro MCP Orchestrator',
          version: '1.0.0',
          status: 'running',
          websocket: this.io ? 'enabled' : 'disabled',
          endpoints: {
            health: '/health',
            mcps: '/api/mcps',
            api: '/api/*',
            google_oauth: '/calendar/google/connect?coachId={id}&redirect_uri={uri}',
            oauth_status: '/coach/{coachId}/google-oauth-status', 
            calendar_events: '/calendar/events?coachId={id}',
            websocket: '/socket.io'
          },
          websocket_events: {
            calendar_sync: 'calendar:sync',
            oauth_status: 'oauth:status',
            google_workspace: 'google-workspace',
            calendar_request: 'calendar-request'
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

  async forwardToMCP(mcp, fullUrl, method, body, headers) {
    const fetch = require('node-fetch');
    
    try {
      let targetUrl;
      
      // Handle different URL formats
      if (fullUrl.startsWith('http://') || fullUrl.startsWith('https://')) {
        // Full URL provided
        const originalUrl = new URL(fullUrl);
        targetUrl = `${mcp.url}${originalUrl.pathname}${originalUrl.search}`;
      } else if (fullUrl.startsWith('/')) {
        // Relative URL with potential query parameters
        if (fullUrl.includes('?')) {
          // URL has query parameters
          targetUrl = `${mcp.url}${fullUrl}`;
        } else {
          // Simple path
          targetUrl = `${mcp.url}${fullUrl}`;
        }
      } else {
        // Just a path, construct full URL
        targetUrl = `${mcp.url}/${fullUrl}`;
      }
      
      const options = {
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': headers['x-api-key'] || process.env.MCP_API_KEY,
          'user-agent': headers['user-agent'] || 'MCP-Orchestrator/1.0.0'
        },
        timeout: mcp.timeout || 30000
      };

      if (body && method !== 'GET') {
        options.body = typeof body === 'string' ? body : JSON.stringify(body);
      }

      this.logger.info(`🔄 Forwarding ${method} ${fullUrl} → ${targetUrl} to MCP ${mcp.name}`);
      const response = await fetch(targetUrl, options);
      
      let data;
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        data = await response.json();
      } else {
        data = await response.text();
      }

      this.logger.info(`✅ MCP ${mcp.name} responded with status ${response.status}`);
      if (response.status >= 400) {
        this.logger.error(`❌ MCP ${mcp.name} error response:`, data);
      }

      return {
        status: response.status,
        data,
        headers: Object.fromEntries(response.headers)
      };
    } catch (error) {
      this.logger.error(`❌ Failed to forward to MCP ${mcp.name}:`, error);
      return {
        status: 500,
        data: { 
          error: 'MCP forwarding failed', 
          message: error.message,
          mcp: mcp.name 
        }
      };
    }
  }

  async start() {
    await this.initialize();

    // Create HTTP server
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    // Create Socket.IO server
    this.io = new Server(this.server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      },
      path: '/socket.io/'
    });

    // Handle Socket.IO connections
    this.io.on('connection', (socket) => {
      this.handleSocketConnection(socket);
    });

    this.server.listen(PORT, () => {
      this.logger.info(`✅ MCP Orchestrator Server running on port ${PORT}`);
      this.logger.info(`🌐 Health check: http://localhost:${PORT}/health`);
      this.logger.info(`🔍 MCP discovery: http://localhost:${PORT}/api/mcps`);
      this.logger.info(`🔌 Socket.IO endpoint: http://localhost:${PORT}/socket.io/`);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());
  }

  async handleSocketConnection(socket) {
    this.logger.info(`🔌 Socket.IO connection established: ${socket.id}`);

    // Handle Google Workspace events
    socket.on('google-workspace', async (data, callback) => {
      try {
        this.logger.info('📨 Google Workspace request received:', data);
        
        const targetMcp = this.discoveryService.getMcp('google-workspace');
        if (!targetMcp) {
          const error = { error: 'Google Workspace MCP not available' };
          if (callback) callback(error);
          return;
        }

        // Forward to Google Workspace MCP via HTTP
        if (data.endpoint) {
          const result = await this.forwardToMCP(targetMcp, data.endpoint, data.method || 'GET', data.body, data.headers || {});
          if (callback) callback(result);
        } else {
          const success = { success: true, message: 'Google Workspace MCP available' };
          if (callback) callback(success);
        }
      } catch (error) {
        this.logger.error('Google Workspace Socket.IO error:', error);
        const errorResponse = { error: error.message };
        if (callback) callback(errorResponse);
      }
    });

    // Handle calendar events specifically
    socket.on('calendar-request', async (data, callback) => {
      try {
        const targetMcp = this.discoveryService.getMcp('google-workspace');
        if (!targetMcp) {
          if (callback) callback({ error: 'Google Workspace MCP not available' });
          return;
        }

        const endpoint = data.endpoint || '/calendar/events';
        const result = await this.forwardToMCP(targetMcp, endpoint, data.method || 'GET', data.body, data.headers || {});
        if (callback) callback(result);
      } catch (error) {
        this.logger.error('Calendar request error:', error);
        if (callback) callback({ error: error.message });
      }
    });

    // Handle calendar sync requests
    socket.on('calendar:sync', async (data) => {
      try {
        const { coachId } = data;
        if (!coachId) {
          socket.emit('calendar:error', { error: 'coachId is required' });
          return;
        }

        const googleWorkspaceMcp = this.discoveryService.getMcp('google-workspace');
        if (!googleWorkspaceMcp || googleWorkspaceMcp.status !== 'active') {
          socket.emit('calendar:sync:response', {
            status: 'mock_mode',
            message: 'Google Workspace MCP not available',
            events: []
          });
          return;
        }

        // Forward to Google Workspace MCP for calendar sync
        const result = await this.forwardToMCP(
          googleWorkspaceMcp,
          `/calendar/sync`,
          'POST',
          { coachId },
          { 'x-api-key': process.env.MCP_API_KEY }
        );

        // Handle MCP errors and fall back to mock mode
        if (result.status === 404 || result.status >= 400) {
          socket.emit('calendar:sync:response', {
            status: 'mock_mode',
            message: `Google Workspace MCP route not found (${result.status})`,
            events: [],
            mcp_response: result.data
          });
          return;
        }

        socket.emit('calendar:sync:response', result.data);
      } catch (error) {
        this.logger.error('Calendar sync error:', error);
        socket.emit('calendar:error', { 
          error: 'Calendar sync failed',
          message: error.message 
        });
      }
    });

    // Handle OAuth status checks
    socket.on('oauth:status', async (data) => {
      try {
        const { coachId } = data;
        if (!coachId) {
          socket.emit('oauth:error', { error: 'coachId is required' });
          return;
        }

        const googleWorkspaceMcp = this.discoveryService.getMcp('google-workspace');
        if (!googleWorkspaceMcp || googleWorkspaceMcp.status !== 'active') {
          socket.emit('oauth:status:response', {
            connected: false,
            status: 'mock_mode',
            message: 'Google Workspace MCP not available'
          });
          return;
        }

        const result = await this.forwardToMCP(
          googleWorkspaceMcp,
          `/oauth/status/${coachId}`,
          'GET',
          null,
          { 'x-api-key': process.env.MCP_API_KEY }
        );

        // Handle MCP errors and fall back to mock mode
        if (result.status === 404 || result.status >= 400) {
          socket.emit('oauth:status:response', {
            connected: false,
            status: 'mock_mode',
            last_sync: null,
            scopes: [],
            message: `Google Workspace MCP route not found (${result.status})`,
            mcp_response: result.data
          });
          return;
        }

        socket.emit('oauth:status:response', result.data);
      } catch (error) {
        this.logger.error('OAuth status check error:', error);
        socket.emit('oauth:error', { 
          error: 'OAuth status check failed',
          message: error.message 
        });
      }
    });

    socket.on('disconnect', () => {
      this.logger.info(`🔌 Socket.IO connection closed: ${socket.id}`);
    });

    socket.on('error', (error) => {
      this.logger.error('Socket.IO error:', error);
    });
  }

  async shutdown() {
    this.logger.info('🛑 Shutting down server...');
    if (this.io) {
      this.io.close();
    }
    if (this.server) {
      this.server.close();
    }
    if (this.discoveryService) {
      await this.discoveryService.shutdown();
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