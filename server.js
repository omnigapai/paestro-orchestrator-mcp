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
      res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
      res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
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

      // Serve OAuth callback HTML page
      if (pathname === '/oauth-callback' && method === 'GET') {
        const fs = require('fs');
        const path = require('path');
        const callbackPath = path.join(__dirname, 'oauth-callback.html');
        
        if (fs.existsSync(callbackPath)) {
          const html = fs.readFileSync(callbackPath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
        } else {
          // Fallback if file doesn't exist
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<!DOCTYPE html>
<html><body>
<script>
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');
  
  // Try to exchange the token immediately
  const baseUrl = window.location.hostname.includes('railway.app') 
    ? 'https://paestro-orchestrator-mcp-production.up.railway.app'
    : '';
  fetch(baseUrl + '/oauth/google/token-exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, state })
  }).then(r => r.json()).then(data => {
    if (window.opener) {
      window.opener.postMessage({ 
        type: 'oauth-success', 
        data
      }, '*');
      setTimeout(() => window.close(), 1000);
    }
  }).catch(err => {
    if (window.opener) {
      window.opener.postMessage({ 
        type: 'oauth-error', 
        error: err.message
      }, '*');
    }
  });
  document.body.innerHTML = '<h2>Processing OAuth... This window will close automatically.</h2>';
</script>
</body></html>`);
        }
        return;
      }
      
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

          // Forward to the Google MCP's oauth-url endpoint with query parameters
          // Convert coachId to coach_id for Google Workspace MCP compatibility
          const newParams = new URLSearchParams();
          for (const [key, value] of url.searchParams) {
            if (key === 'coachId') {
              newParams.set('coach_id', value);  // Convert coachId to coach_id
            } else {
              newParams.set(key, value);
            }
          }
          const queryParams = newParams.toString();
          const oauthEndpoint = `/google/oauth-url${queryParams ? '?' + queryParams : ''}`;
          
          const result = await this.forwardToMCP(
            googleWorkspaceMcp, 
            oauthEndpoint,  // Include query parameters with coach_id
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

      // Get Google Contacts for coach
      if (pathname.match(/^\/coach\/[^/]+\/google-contacts$/) && method === 'GET') {
        const coachId = pathname.split('/')[2];
        
        try {
          const googleWorkspaceMcp = this.discoveryService.getMcp('google-workspace');
          if (!googleWorkspaceMcp || googleWorkspaceMcp.status !== 'active') {
            // Provide mock contacts if Google Workspace MCP is not available
            res.writeHead(200);
            res.end(JSON.stringify({ 
              success: true,
              contacts: [],
              total: 0,
              coach_id: coachId,
              message: 'Google Workspace MCP not available, returning empty contacts'
            }));
            return;
          }

          const result = await this.forwardToMCP(
            googleWorkspaceMcp, 
            `/coach/${coachId}/google-contacts`,
            'GET',
            null,
            req.headers
          );
          
          // If MCP returns 404 or other error, return empty contacts
          if (result.status === 404 || result.status >= 400) {
            res.writeHead(200);
            res.end(JSON.stringify({ 
              success: false,
              contacts: [],
              total: 0,
              coach_id: coachId,
              message: `Google Contacts not available (${result.status})`,
              error: result.data
            }));
            return;
          }
          
          res.writeHead(result.status || 200);
          res.end(JSON.stringify(result.data));
        } catch (error) {
          this.logger.error('Google Contacts error:', error);
          res.writeHead(500);
          res.end(JSON.stringify({ 
            success: false,
            error: 'Failed to fetch Google Contacts',
            details: error.message,
            contacts: [],
            total: 0,
            coach_id: coachId
          }));
        }
        return;
      }

      // Get Google Sheets Contacts for coach
      if (pathname.match(/^\/coach\/[^/]+\/sheets-contacts$/) && method === 'GET') {
        const coachId = pathname.split('/')[2];
        
        try {
          const googleWorkspaceMcp = this.discoveryService.getMcp('google-workspace');
          if (!googleWorkspaceMcp || googleWorkspaceMcp.status !== 'active') {
            res.writeHead(200);
            res.end(JSON.stringify({ 
              success: false,
              contacts: [],
              total: 0,
              coach_id: coachId,
              message: 'Google Workspace MCP not available'
            }));
            return;
          }

          // Forward to Google Workspace MCP REST-style route to get contacts from Google Sheets
          const result = await this.forwardToMCP(
            googleWorkspaceMcp, 
            `/coach/${coachId}/sheets-contacts`,
            'GET',
            null,
            req.headers
          );
          
          res.writeHead(result.status || 200);
          res.end(JSON.stringify(result.data));
        } catch (error) {
          this.logger.error('Google Sheets Contacts error:', error);
          res.writeHead(500);
          res.end(JSON.stringify({ 
            success: false,
            error: 'Failed to fetch Google Sheets Contacts',
            details: error.message,
            contacts: [],
            total: 0,
            coach_id: coachId
          }));
        }
        return;
      }

      // Add contact to Google Sheets
      if (pathname.match(/^\/coach\/[^/]+\/sheets-contacts$/) && method === 'POST') {
        const coachId = pathname.split('/')[2];
        const body = await this.getRequestBody(req);
        
        try {
          const googleWorkspaceMcp = this.discoveryService.getMcp('google-workspace');
          if (!googleWorkspaceMcp || googleWorkspaceMcp.status !== 'active') {
            res.writeHead(200);
            res.end(JSON.stringify({ 
              success: false,
              error: 'Google Workspace MCP not available'
            }));
            return;
          }

          // Forward to Google Workspace MCP REST-style route to add contact to Google Sheets
          const result = await this.forwardToMCP(
            googleWorkspaceMcp, 
            `/coach/${coachId}/sheets-contacts`,
            'POST',
            body, // Pass the contact data directly
            req.headers
          );
          
          res.writeHead(result.status || 200);
          res.end(JSON.stringify(result.data));
        } catch (error) {
          this.logger.error('Add Google Sheets Contact error:', error);
          res.writeHead(500);
          res.end(JSON.stringify({ 
            success: false,
            error: 'Failed to add contact to Google Sheets',
            details: error.message
          }));
        }
        return;
      }

      // Update contact in Google Sheets
      if (pathname.match(/^\/coach\/[^/]+\/sheets-contacts\/[^/]+$/) && method === 'PUT') {
        const parts = pathname.split('/');
        const coachId = parts[2];
        const contactId = parts[4];
        const body = await this.getRequestBody(req);
        
        try {
          const googleWorkspaceMcp = this.discoveryService.getMcp('google-workspace');
          if (!googleWorkspaceMcp || googleWorkspaceMcp.status !== 'active') {
            res.writeHead(200);
            res.end(JSON.stringify({ 
              success: false,
              error: 'Google Workspace MCP not available'
            }));
            return;
          }

          // Forward to Google Workspace MCP HTTP route to update contact in Google Sheets
          const result = await this.forwardToMCP(
            googleWorkspaceMcp, 
            '/sheets-contacts/update',
            'POST',
            {
              coach_id: coachId,
              contact_id: contactId,
              updates: body
            },
            req.headers
          );
          
          res.writeHead(result.status || 200);
          res.end(JSON.stringify(result.data));
        } catch (error) {
          this.logger.error('Update Google Sheets Contact error:', error);
          res.writeHead(500);
          res.end(JSON.stringify({ 
            success: false,
            error: 'Failed to update contact in Google Sheets',
            details: error.message
          }));
        }
        return;
      }

      // Delete contact from Google Sheets
      if (pathname.match(/^\/coach\/[^/]+\/sheets-contacts\/[^/]+$/) && method === 'DELETE') {
        const parts = pathname.split('/');
        const coachId = parts[2];
        const contactId = parts[4];
        
        try {
          const googleWorkspaceMcp = this.discoveryService.getMcp('google-workspace');
          if (!googleWorkspaceMcp || googleWorkspaceMcp.status !== 'active') {
            res.writeHead(200);
            res.end(JSON.stringify({ 
              success: false,
              error: 'Google Workspace MCP not available'
            }));
            return;
          }

          // Forward to Google Workspace MCP HTTP route to delete contact from Google Sheets
          const result = await this.forwardToMCP(
            googleWorkspaceMcp, 
            '/sheets-contacts/delete',
            'POST',
            {
              coach_id: coachId,
              contact_id: contactId
            },
            req.headers
          );
          
          res.writeHead(result.status || 200);
          res.end(JSON.stringify(result.data));
        } catch (error) {
          this.logger.error('Delete Google Sheets Contact error:', error);
          res.writeHead(500);
          res.end(JSON.stringify({ 
            success: false,
            error: 'Failed to delete contact from Google Sheets',
            details: error.message
          }));
        }
        return;
      }

      // Initialize Google Sheets contact database for coach
      if (pathname.match(/^\/coach\/[^/]+\/init-sheets-contacts$/) && method === 'POST') {
        const coachId = pathname.split('/')[2];
        const body = await this.getRequestBody(req);
        
        try {
          const googleWorkspaceMcp = this.discoveryService.getMcp('google-workspace');
          if (!googleWorkspaceMcp || googleWorkspaceMcp.status !== 'active') {
            res.writeHead(200);
            res.end(JSON.stringify({ 
              success: false,
              error: 'Google Workspace MCP not available'
            }));
            return;
          }

          // Forward to Google Workspace MCP REST-style endpoint to create/initialize Google Sheet for contacts
          const result = await this.forwardToMCP(
            googleWorkspaceMcp, 
            `/coach/${coachId}/init-sheets-contacts`,
            'POST',
            body, // Pass the body as-is (contains sheet_name)
            req.headers
          );
          
          res.writeHead(result.status || 200);
          res.end(JSON.stringify(result.data));
        } catch (error) {
          this.logger.error('Initialize Google Sheets Contacts error:', error);
          res.writeHead(500);
          res.end(JSON.stringify({ 
            success: false,
            error: 'Failed to initialize Google Sheets for contacts',
            details: error.message
          }));
        }
        return;
      }

      // Add a new contact to Google Sheets
      if (pathname.match(/^\/coach\/[^/]+\/add-sheets-contact$/) && method === 'POST') {
        const coachId = pathname.split('/')[2];
        const body = await this.getRequestBody(req);
        
        try {
          const googleWorkspaceMcp = this.discoveryService.getMcp('google-workspace');
          if (!googleWorkspaceMcp || googleWorkspaceMcp.status !== 'active') {
            res.writeHead(200);
            res.end(JSON.stringify({ 
              success: false,
              error: 'Google Workspace MCP not available'
            }));
            return;
          }

          const result = await this.forwardToMCP(
            googleWorkspaceMcp, 
            `/coach/${coachId}/add-sheets-contact`,
            'POST',
            body,
            req.headers
          );
          
          res.writeHead(result.status || 200);
          res.end(JSON.stringify(result.data));
        } catch (error) {
          this.logger.error('Add Google Sheets Contact error:', error);
          res.writeHead(500);
          res.end(JSON.stringify({ 
            success: false,
            error: 'Failed to add contact to Google Sheets',
            details: error.message
          }));
        }
        return;
      }

      // Update an existing contact in Google Sheets
      if (pathname.match(/^\/coach\/[^/]+\/update-sheets-contact\/[^/]+$/) && method === 'PUT') {
        const parts = pathname.split('/');
        const coachId = parts[2];
        const contactId = parts[4];
        const body = await this.getRequestBody(req);
        
        try {
          const googleWorkspaceMcp = this.discoveryService.getMcp('google-workspace');
          if (!googleWorkspaceMcp || googleWorkspaceMcp.status !== 'active') {
            res.writeHead(200);
            res.end(JSON.stringify({ 
              success: false,
              error: 'Google Workspace MCP not available'
            }));
            return;
          }

          const result = await this.forwardToMCP(
            googleWorkspaceMcp, 
            `/coach/${coachId}/update-sheets-contact/${contactId}`,
            'PUT',
            body,
            req.headers
          );
          
          res.writeHead(result.status || 200);
          res.end(JSON.stringify(result.data));
        } catch (error) {
          this.logger.error('Update Google Sheets Contact error:', error);
          res.writeHead(500);
          res.end(JSON.stringify({ 
            success: false,
            error: 'Failed to update contact in Google Sheets',
            details: error.message
          }));
        }
        return;
      }

      // Delete a contact from Google Sheets
      if (pathname.match(/^\/coach\/[^/]+\/delete-sheets-contact\/[^/]+$/) && method === 'DELETE') {
        const parts = pathname.split('/');
        const coachId = parts[2];
        const contactId = parts[4];
        
        try {
          const googleWorkspaceMcp = this.discoveryService.getMcp('google-workspace');
          if (!googleWorkspaceMcp || googleWorkspaceMcp.status !== 'active') {
            res.writeHead(200);
            res.end(JSON.stringify({ 
              success: false,
              error: 'Google Workspace MCP not available'
            }));
            return;
          }

          const result = await this.forwardToMCP(
            googleWorkspaceMcp, 
            `/coach/${coachId}/delete-sheets-contact/${contactId}`,
            'DELETE',
            null,
            req.headers
          );
          
          res.writeHead(result.status || 200);
          res.end(JSON.stringify(result.data));
        } catch (error) {
          this.logger.error('Delete Google Sheets Contact error:', error);
          res.writeHead(500);
          res.end(JSON.stringify({ 
            success: false,
            error: 'Failed to delete contact from Google Sheets',
            details: error.message
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

      // OAuth token exchange endpoints - Handle authorization code exchange
      if ((pathname === '/oauth/exchange' || pathname === '/oauth/google/token-exchange') && method === 'POST') {
        const body = await this.getRequestBody(req);
        let { code, coachId, coachEmail, state, redirectUri } = body;
        
        // Ensure we have an authorization code
        if (!code) {
          res.writeHead(400);
          res.end(JSON.stringify({ 
            success: false,
            error: 'Missing authorization code - cannot proceed with OAuth token exchange' 
          }));
          return;
        }

        // Provide default coachId if missing to prevent 400 errors
        if (!coachId || coachId.trim() === '') {
          coachId = 'default-coach';
          this.logger.warn('No coachId provided in OAuth exchange, using default-coach');
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

          // ENTERPRISE PATTERN: Orchestrator only coordinates, doesn't proxy storage
          // Google Workspace MCP will handle token storage directly with Main MCP
          
          this.logger.info('Routing OAuth exchange to Google Workspace MCP (enterprise pattern)');
          
          // Forward to Google Workspace MCP - it will handle everything including storage
          const tokenResult = await this.forwardToMCP(
            googleWorkspaceMcp, 
            '/oauth/exchange',
            'POST',
            { 
              code, 
              coachId, 
              coachEmail, 
              state, 
              redirectUri: redirectUri || 'http://localhost:8080/oauth-callback',
              // Signal to Google MCP that it should store tokens directly
              directStorage: true 
            },
            req.headers
          );
          
          // Log the result for monitoring
          if (tokenResult.data?.success) {
            this.logger.info('OAuth flow completed successfully via service mesh pattern', {
              coachId: coachId?.substring(0, 8) + '...',
              storage: tokenResult.data?.storage || 'unknown'
            });
          } else {
            this.logger.error('OAuth flow failed', tokenResult.data?.error);
          }
          
          // Return the result from the Google MCP
          res.writeHead(tokenResult.status || 200);
          res.end(JSON.stringify(tokenResult.data));
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
          version: '1.0.1', // OAuth callback fix deployed
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

  async callMCPTool(mcp, toolName, params = {}) {
    const fetch = require('node-fetch');
    
    try {
      const targetUrl = `${mcp.url}/mcp/v1/tools/call`;
      
      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: toolName,
          arguments: params
        }),
        timeout: mcp.timeout || 30000
      };
      
      this.logger.info(`🔧 Calling MCP tool ${toolName} on ${mcp.name}`);
      const response = await fetch(targetUrl, options);
      
      let data;
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        data = await response.json();
      } else {
        data = await response.text();
      }
      
      this.logger.info(`✅ MCP tool ${toolName} responded with status ${response.status}`);
      
      return {
        status: response.status,
        data,
        headers: Object.fromEntries(response.headers)
      };
    } catch (error) {
      this.logger.error(`❌ Failed to call MCP tool ${toolName}:`, error);
      return {
        status: 500,
        data: { 
          error: 'MCP tool call failed', 
          message: error.message,
          tool: toolName,
          mcp: mcp.name 
        }
      };
    }
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

    // Bind to 0.0.0.0 for Railway deployment
    const HOST = process.env.HOST || '0.0.0.0';
    this.server.listen(PORT, HOST, () => {
      this.logger.info(`✅ MCP Orchestrator Server running on ${HOST}:${PORT}`);
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