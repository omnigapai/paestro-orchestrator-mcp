const EventEmitter = require('events');
const { spawn } = require('child_process');

/**
 * Circuit Breaker States
 */
const CircuitBreakerState = {
  CLOSED: 'CLOSED',     // Normal operation
  OPEN: 'OPEN',         // Failing, reject requests
  HALF_OPEN: 'HALF_OPEN' // Testing if service recovered
};

/**
 * Circuit Breaker Implementation
 */
class CircuitBreaker extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      failureThreshold: options.failureThreshold || 5,
      resetTimeout: options.resetTimeout || 30000,
      monitoringPeriod: options.monitoringPeriod || 10000,
      ...options
    };
    
    this.state = CircuitBreakerState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = null;
    this.nextAttempt = null;
    this.metrics = {
      totalRequests: 0,
      totalFailures: 0,
      totalSuccesses: 0,
      stateChanges: 0
    };
    
    // Reset failure count periodically
    this.monitoringTimer = setInterval(() => {
      this.failures = 0;
      this.successes = 0;
    }, this.options.monitoringPeriod);
  }

  /**
   * Execute function with circuit breaker protection
   */
  async execute(fn, ...args) {
    this.metrics.totalRequests++;
    
    if (this.state === CircuitBreakerState.OPEN) {
      if (Date.now() < this.nextAttempt) {
        const error = new Error('Circuit breaker is OPEN');
        error.code = 'CIRCUIT_BREAKER_OPEN';
        throw error;
      } else {
        this.state = CircuitBreakerState.HALF_OPEN;
        this.emit('state_change', this.state);
        this.metrics.stateChanges++;
      }
    }
    
    try {
      const result = await fn(...args);
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Handle successful execution
   */
  onSuccess() {
    this.successes++;
    this.metrics.totalSuccesses++;
    
    if (this.state === CircuitBreakerState.HALF_OPEN) {
      this.state = CircuitBreakerState.CLOSED;
      this.failures = 0;
      this.emit('state_change', this.state);
      this.metrics.stateChanges++;
    }
  }

  /**
   * Handle failed execution
   */
  onFailure() {
    this.failures++;
    this.metrics.totalFailures++;
    this.lastFailureTime = Date.now();
    
    if (this.failures >= this.options.failureThreshold) {
      this.state = CircuitBreakerState.OPEN;
      this.nextAttempt = Date.now() + this.options.resetTimeout;
      this.emit('state_change', this.state);
      this.metrics.stateChanges++;
    }
  }

  /**
   * Get circuit breaker status
   */
  getStatus() {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureTime: this.lastFailureTime,
      nextAttempt: this.nextAttempt,
      metrics: { ...this.metrics }
    };
  }

  /**
   * Manually trip the circuit breaker
   */
  trip() {
    this.state = CircuitBreakerState.OPEN;
    this.nextAttempt = Date.now() + this.options.resetTimeout;
    this.emit('state_change', this.state);
    this.metrics.stateChanges++;
  }

  /**
   * Reset circuit breaker to closed state
   */
  reset() {
    this.state = CircuitBreakerState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = null;
    this.nextAttempt = null;
    this.emit('state_change', this.state);
    this.metrics.stateChanges++;
  }

  /**
   * Cleanup
   */
  destroy() {
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
    }
  }
}

/**
 * Connection Pool for managing MCP connections
 */
class ConnectionPool extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      maxSize: options.maxSize || 10,
      minSize: options.minSize || 2,
      acquireTimeout: options.acquireTimeout || 30000,
      idleTimeout: options.idleTimeout || 300000,
      ...options
    };
    
    this.connections = new Set();
    this.availableConnections = [];
    this.pendingAcquires = [];
    this.totalCreated = 0;
    this.totalDestroyed = 0;
  }

  /**
   * Acquire a connection from the pool
   */
  async acquire() {
    // Try to get an available connection
    if (this.availableConnections.length > 0) {
      const connection = this.availableConnections.pop();
      this.emit('connection_acquired', connection);
      return connection;
    }
    
    // Create new connection if under max size
    if (this.connections.size < this.options.maxSize) {
      const connection = await this.createConnection();
      return connection;
    }
    
    // Wait for a connection to become available
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.pendingAcquires.indexOf(acquire);
        if (index >= 0) {
          this.pendingAcquires.splice(index, 1);
        }
        reject(new Error('Acquire timeout'));
      }, this.options.acquireTimeout);
      
      const acquire = { resolve, reject, timeout };
      this.pendingAcquires.push(acquire);
    });
  }

  /**
   * Release a connection back to the pool
   */
  release(connection) {
    if (!this.connections.has(connection)) {
      return; // Connection not from this pool
    }
    
    // Handle pending acquires first
    if (this.pendingAcquires.length > 0) {
      const acquire = this.pendingAcquires.shift();
      clearTimeout(acquire.timeout);
      acquire.resolve(connection);
      this.emit('connection_acquired', connection);
      return;
    }
    
    // Add to available connections
    connection.lastUsed = Date.now();
    this.availableConnections.push(connection);
    this.emit('connection_released', connection);
  }

  /**
   * Create a new connection
   */
  async createConnection() {
    const connection = await this.options.connectionFactory();
    connection.id = `conn_${++this.totalCreated}`;
    connection.createdAt = Date.now();
    connection.lastUsed = Date.now();
    
    this.connections.add(connection);
    this.emit('connection_created', connection);
    return connection;
  }

  /**
   * Destroy a connection
   */
  async destroyConnection(connection) {
    this.connections.delete(connection);
    
    const availableIndex = this.availableConnections.indexOf(connection);
    if (availableIndex >= 0) {
      this.availableConnections.splice(availableIndex, 1);
    }
    
    if (connection.destroy) {
      await connection.destroy();
    }
    
    this.totalDestroyed++;
    this.emit('connection_destroyed', connection);
  }

  /**
   * Clean up idle connections
   */
  cleanupIdleConnections() {
    const now = Date.now();
    const idleConnections = this.availableConnections.filter(conn => 
      now - conn.lastUsed > this.options.idleTimeout
    );
    
    for (const connection of idleConnections) {
      this.destroyConnection(connection);
    }
  }

  /**
   * Get pool statistics
   */
  getStats() {
    return {
      totalConnections: this.connections.size,
      availableConnections: this.availableConnections.length,
      pendingAcquires: this.pendingAcquires.length,
      totalCreated: this.totalCreated,
      totalDestroyed: this.totalDestroyed
    };
  }

  /**
   * Destroy all connections and cleanup
   */
  async destroy() {
    const connections = Array.from(this.connections);
    await Promise.all(connections.map(conn => this.destroyConnection(conn)));
    
    // Reject pending acquires
    for (const acquire of this.pendingAcquires) {
      clearTimeout(acquire.timeout);
      acquire.reject(new Error('Pool destroyed'));
    }
    this.pendingAcquires = [];
  }
}

/**
 * Universal MCP Client with resilience patterns
 */
class MCPClient extends EventEmitter {
  constructor(mcpConfig, options = {}) {
    super();
    
    this.mcpConfig = mcpConfig;
    this.options = {
      maxRetries: options.maxRetries || 3,
      baseDelay: options.baseDelay || 1000,
      maxDelay: options.maxDelay || 30000,
      backoffMultiplier: options.backoffMultiplier || 2,
      jitterFactor: options.jitterFactor || 0.1,
      timeout: options.timeout || 30000,
      poolSize: options.poolSize || 5,
      ...options
    };
    
    this.logger = options.logger || console;
    
    // Circuit breaker
    this.circuitBreaker = new CircuitBreaker(mcpConfig.circuitBreaker || {});
    this.circuitBreaker.on('state_change', (state) => {
      this.emit('circuit_breaker_state_change', state);
      this.logger.info(`Circuit breaker state changed to ${state} for MCP ${mcpConfig.name}`);
    });
    
    // Connection pool
    this.connectionPool = new ConnectionPool({
      maxSize: this.options.poolSize,
      connectionFactory: () => this.createConnection()
    });
    
    // Request/response interceptors
    this.requestInterceptors = [];
    this.responseInterceptors = [];
    
    // Metrics
    this.metrics = {
      requests: 0,
      successes: 0,
      failures: 0,
      retries: 0,
      timeouts: 0,
      avgLatency: 0,
      totalLatency: 0,
      lastRequest: null
    };
    
    this.isShuttingDown = false;
    
    // Cleanup timer
    this.cleanupTimer = setInterval(() => {
      this.connectionPool.cleanupIdleConnections();
    }, 60000);
  }

  /**
   * Add request interceptor
   */
  addRequestInterceptor(interceptor) {
    this.requestInterceptors.push(interceptor);
  }

  /**
   * Add response interceptor
   */
  addResponseInterceptor(interceptor) {
    this.responseInterceptors.push(interceptor);
  }

  /**
   * Create connection based on MCP endpoint configuration
   */
  async createConnection() {
    const endpoint = this.mcpConfig.endpoints.primary;
    
    if (endpoint.protocol === 'stdio') {
      return await this.createStdioConnection(endpoint);
    } else if (endpoint.protocol === 'http') {
      return await this.createHttpConnection(endpoint);
    } else {
      throw new Error(`Unsupported protocol: ${endpoint.protocol}`);
    }
  }

  /**
   * Create STDIO-based connection
   */
  async createStdioConnection(endpoint) {
    return new Promise((resolve, reject) => {
      const process = spawn(endpoint.command, endpoint.args || [], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      let initialized = false;
      const messageQueue = [];
      const pendingRequests = new Map();
      let requestId = 0;
      
      const connection = {
        type: 'stdio',
        process,
        send: async (message) => {
          const id = ++requestId;
          const request = { ...message, id };
          
          // Apply request interceptors
          for (const interceptor of this.requestInterceptors) {
            await interceptor(request);
          }
          
          return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              pendingRequests.delete(id);
              reject(new Error('Request timeout'));
            }, this.options.timeout);
            
            pendingRequests.set(id, { resolve, reject, timeout });
            process.stdin.write(JSON.stringify(request) + '\n');
          });
        },
        destroy: async () => {
          process.kill();
        }
      };
      
      // Handle stdout (responses)
      let buffer = '';
      process.stdout.on('data', async (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.trim()) {
            try {
              const response = JSON.parse(line);
              
              if (response.id && pendingRequests.has(response.id)) {
                const pending = pendingRequests.get(response.id);
                clearTimeout(pending.timeout);
                pendingRequests.delete(response.id);
                
                // Apply response interceptors
                for (const interceptor of this.responseInterceptors) {
                  await interceptor(response);
                }
                
                if (response.error) {
                  pending.reject(new Error(response.error.message || 'MCP Error'));
                } else {
                  pending.resolve(response.result);
                }
              }
            } catch (error) {
              this.logger.warn('Failed to parse MCP response:', error);
            }
          }
        }
      });
      
      // Handle stderr (logs)
      process.stderr.on('data', (data) => {
        this.logger.debug(`MCP ${this.mcpConfig.name} stderr:`, data.toString());
      });
      
      // Handle process events
      process.on('error', (error) => {
        if (!initialized) {
          reject(error);
        } else {
          this.emit('connection_error', error);
        }
      });
      
      process.on('exit', (code) => {
        this.emit('connection_closed', code);
        
        // Reject all pending requests
        for (const pending of pendingRequests.values()) {
          clearTimeout(pending.timeout);
          pending.reject(new Error('Connection closed'));
        }
        pendingRequests.clear();
      });
      
      // Initialize MCP protocol
      setTimeout(async () => {
        try {
          await connection.send({
            jsonrpc: '2.0',
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: {
                name: 'orchestrator-mcp',
                version: '1.0.0'
              }
            }
          });
          
          initialized = true;
          resolve(connection);
        } catch (error) {
          reject(error);
        }
      }, 100);
    });
  }

  /**
   * Create HTTP-based connection
   */
  async createHttpConnection(endpoint) {
    const fetch = require('node-fetch');
    
    const connection = {
      type: 'http',
      baseUrl: endpoint.url,
      headers: endpoint.headers || {},
      send: async (message) => {
        // Apply request interceptors
        for (const interceptor of this.requestInterceptors) {
          await interceptor(message);
        }
        
        const response = await fetch(`${endpoint.url}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...connection.headers
          },
          body: JSON.stringify(message),
          timeout: this.options.timeout
        });
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const result = await response.json();
        
        // Apply response interceptors
        for (const interceptor of this.responseInterceptors) {
          await interceptor(result);
        }
        
        if (result.error) {
          throw new Error(result.error.message || 'MCP Error');
        }
        
        return result.result;
      },
      destroy: async () => {
        // HTTP connections don't need explicit cleanup
      }
    };
    
    return connection;
  }

  /**
   * Call MCP tool with retry and circuit breaker
   */
  async callTool(toolName, parameters = {}) {
    const startTime = Date.now();
    this.metrics.requests++;
    this.metrics.lastRequest = new Date();
    
    const executeCall = async () => {
      const connection = await this.connectionPool.acquire();
      
      try {
        const result = await connection.send({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: parameters
          }
        });
        
        this.connectionPool.release(connection);
        return result;
      } catch (error) {
        this.connectionPool.release(connection);
        throw error;
      }
    };
    
    try {
      const result = await this.circuitBreaker.execute(
        () => this.executeWithRetry(executeCall)
      );
      
      // Update metrics
      this.metrics.successes++;
      const latency = Date.now() - startTime;
      this.metrics.totalLatency += latency;
      this.metrics.avgLatency = this.metrics.totalLatency / this.metrics.successes;
      
      this.emit('tool_call_success', toolName, parameters, result);
      return result;
      
    } catch (error) {
      this.metrics.failures++;
      this.emit('tool_call_error', toolName, parameters, error);
      throw error;
    }
  }

  /**
   * Execute function with exponential backoff retry
   */
  async executeWithRetry(fn) {
    let lastError;
    
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        
        if (attempt === this.options.maxRetries) {
          break; // No more retries
        }
        
        // Check if error is retryable
        if (!this.isRetryableError(error)) {
          break;
        }
        
        this.metrics.retries++;
        
        // Calculate delay with exponential backoff and jitter
        const baseDelay = this.options.baseDelay * Math.pow(this.options.backoffMultiplier, attempt);
        const jitter = baseDelay * this.options.jitterFactor * Math.random();
        const delay = Math.min(baseDelay + jitter, this.options.maxDelay);
        
        this.logger.debug(`Retrying in ${delay}ms (attempt ${attempt + 1}/${this.options.maxRetries})`);
        await this.sleep(delay);
      }
    }
    
    throw lastError;
  }

  /**
   * Check if error is retryable
   */
  isRetryableError(error) {
    // Network errors are retryable
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      return true;
    }
    
    // HTTP 5xx errors are retryable
    if (error.message.includes('HTTP 5')) {
      return true;
    }
    
    // Timeout errors are retryable
    if (error.message.includes('timeout')) {
      this.metrics.timeouts++;
      return true;
    }
    
    // Circuit breaker open is not retryable immediately
    if (error.code === 'CIRCUIT_BREAKER_OPEN') {
      return false;
    }
    
    return false;
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * List available tools
   */
  async listTools() {
    return await this.callTool('list_tools');
  }

  /**
   * Get MCP information
   */
  getMcpInfo() {
    return {
      name: this.mcpConfig.name,
      version: this.mcpConfig.version,
      status: this.mcpConfig.status,
      capabilities: this.mcpConfig.capabilities,
      tools: this.mcpConfig.tools,
      circuitBreaker: this.circuitBreaker.getStatus(),
      pool: this.connectionPool.getStats(),
      metrics: { ...this.metrics }
    };
  }

  /**
   * Get client metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      circuitBreaker: this.circuitBreaker.getStatus(),
      connectionPool: this.connectionPool.getStats()
    };
  }

  /**
   * Check if MCP is healthy
   */
  isHealthy() {
    const cbStatus = this.circuitBreaker.getStatus();
    return cbStatus.state === CircuitBreakerState.CLOSED || 
           cbStatus.state === CircuitBreakerState.HALF_OPEN;
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    this.isShuttingDown = true;
    this.logger.info(`Shutting down MCP client for ${this.mcpConfig.name}...`);
    
    // Clear timers
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    
    // Destroy circuit breaker
    this.circuitBreaker.destroy();
    
    // Destroy connection pool
    await this.connectionPool.destroy();
    
    this.emit('shutdown');
    this.logger.info(`MCP client for ${this.mcpConfig.name} shut down`);
  }
}

module.exports = {
  MCPClient,
  CircuitBreaker,
  ConnectionPool,
  CircuitBreakerState
};