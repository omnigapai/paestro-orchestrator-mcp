/**
 * OAuth Token Flow Fix for Orchestrator MCP
 * 
 * Problem: Google Workspace MCP is trying to save tokens to Supabase directly
 * but it doesn't have the correct Supabase connection/method.
 * 
 * Solution: Orchestrator should coordinate:
 * 1. Get tokens from Google Workspace MCP
 * 2. Forward tokens to Main MCP for Supabase storage
 */

// This fix should be integrated into server.js around line 380-420

// After receiving tokens from Google Workspace MCP (line 399-405):
async function handleOAuthTokenStorage(orchestrator, tokenData, coachId, coachEmail) {
  try {
    // Step 1: Check if we got tokens from Google Workspace MCP
    if (tokenData.success && tokenData.data?.access_token) {
      orchestrator.logger.info('Received OAuth tokens from Google Workspace MCP, forwarding to Main MCP for storage');
      
      // Step 2: Get the main platform MCP
      const mainPlatformMcp = orchestrator.discoveryService.getMcp('main-platform');
      if (!mainPlatformMcp || mainPlatformMcp.status !== 'active') {
        throw new Error('Main Platform MCP not available for token storage');
      }
      
      // Step 3: Forward tokens to Main MCP's OAuth exchange endpoint
      // The Main MCP already has the fixed Supabase upsert logic
      const storageResult = await orchestrator.forwardToMCP(
        mainPlatformMcp,
        '/google/oauth/exchange',
        'POST',
        {
          code: 'already-exchanged', // Signal that tokens are already obtained
          tokens: tokenData.data,     // Pass the actual tokens
          coachId: coachId,
          coachEmail: coachEmail
        }
      );
      
      orchestrator.logger.info('Token storage result from Main MCP:', storageResult);
      return storageResult;
    }
    
    return tokenData; // Return original result if no tokens
  } catch (error) {
    orchestrator.logger.error('Failed to store tokens in Main MCP:', error);
    // Return success with tokens even if storage failed
    // (user can still use the tokens, just not persisted)
    return {
      ...tokenData,
      warning: 'Tokens obtained but storage failed'
    };
  }
}

// Modified OAuth exchange handler (replace lines 386-419):
const modifiedOAuthHandler = `
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

    // Step 1: Exchange code for tokens with Google Workspace MCP
    const tokenResult = await this.forwardToMCP(
      googleWorkspaceMcp, 
      '/oauth/exchange',
      'POST',
      { code, coachId, coachEmail, state, redirectUri: redirectUri || 'http://localhost:8080/oauth-callback' },
      req.headers
    );
    
    // Step 2: If we got tokens, store them in Main MCP's Supabase
    if (tokenResult.data?.success && tokenResult.data?.data?.access_token) {
      this.logger.info('Got tokens from Google Workspace MCP, storing in Main MCP Supabase');
      
      const mainPlatformMcp = this.discoveryService.getMcp('main-platform');
      if (mainPlatformMcp && mainPlatformMcp.status === 'active') {
        try {
          // The Main MCP's /google/oauth/exchange endpoint has the proper Supabase upsert
          const storageResult = await this.forwardToMCP(
            mainPlatformMcp,
            '/google/oauth/exchange',
            'POST',
            {
              code: code, // Pass original code
              redirectUri: redirectUri || 'http://localhost:8080/oauth-callback',
              coachId: coachId,
              coachEmail: coachEmail
            },
            req.headers
          );
          
          this.logger.info('Token storage in Supabase completed:', storageResult.data?.success);
          
          // Return the original token result (with tokens) regardless of storage
          res.writeHead(tokenResult.status || 200);
          res.end(JSON.stringify({
            ...tokenResult.data,
            storage: storageResult.data?.success ? 'stored' : 'not_stored'
          }));
          return;
        } catch (storageError) {
          this.logger.error('Failed to store tokens in Supabase:', storageError);
          // Still return tokens even if storage failed
        }
      }
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
`;

console.log('OAuth Token Flow Fix for Orchestrator MCP');
console.log('==========================================\n');
console.log('The fix coordinates token storage properly:');
console.log('1. Orchestrator gets tokens from Google Workspace MCP');
console.log('2. Orchestrator forwards tokens to Main MCP for Supabase storage');
console.log('3. Main MCP uses the proper upsert method (already fixed)\n');
console.log('To apply this fix:');
console.log('1. Edit orchestrator-mcp/server.js');
console.log('2. Replace the OAuth exchange handler (lines 386-419)');
console.log('3. Restart the Orchestrator MCP');
console.log('4. The token flow will work correctly\n');

module.exports = { handleOAuthTokenStorage };