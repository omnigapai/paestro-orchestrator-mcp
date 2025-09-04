const fs = require('fs').promises;
const path = require('path');
const dns = require('dns').promises;
const dgram = require('dgram');
const EventEmitter = require('events');
const { promisify } = require('util');

/**
 * MCP Discovery Service
 * Handles multiple discovery methods with hot-reload capability
 */
class MCPDiscoveryService extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      registryPath: options.registryPath || path.join(__dirname, 'mcp-registry.json'),
      environment: options.environment || process.env.NODE_ENV || 'development',
      watchDebounceMs: options.watchDebounceMs || 1000,
      dnsDiscoveryDomain: options.dnsDiscoveryDomain || '_mcp._tcp.local',
      multicastAddress: options.multicastAddress || '239.255.255.250',
      multicastPort: options.multicastPort || 1900,
      kubernetesNamespace: options.kubernetesNamespace || 'default',
      cacheTimeout: options.cacheTimeout || 60000,
      healthCheckInterval: options.healthCheckInterval || 30000,
      ...options
    };

    this.registry = null;
    this.mcpCache = new Map();
    this.watchers = new Map();
    this.healthCheckers = new Map();
    this.multicastSocket = null;
    this.isShuttingDown = false;
    
    // Metrics
    this.metrics = {
      registryReloads: 0,
      discoveryEvents: 0,
      healthChecks: 0,
      healthCheckFailures: 0,
      lastReload: null,
      mcpsDiscovered: 0,
      errors: 0
    };

    this.logger = options.logger || console;
  }

  /**
   * Initialize discovery service
   */
  async initialize() {
    try {
      this.logger.info('Initializing MCP Discovery Service...');
      
      // Load initial registry
      await this.loadRegistry();
      
      // Start file watcher
      await this.startFileWatcher();
      
      // Start discovery methods based on environment
      await this.startDiscoveryMethods();
      
      // Start health checking
      this.startHealthChecking();
      
      this.logger.info('MCP Discovery Service initialized successfully');
      this.emit('initialized');
      
    } catch (error) {
      this.metrics.errors++;
      this.logger.error('Failed to initialize discovery service:', error);
      throw error;
    }
  }

  /**
   * Load registry from file with validation
   */
  async loadRegistry() {
    try {
      const registryData = await fs.readFile(this.options.registryPath, 'utf8');
      const newRegistry = JSON.parse(registryData);
      
      // Validate registry structure
      this.validateRegistry(newRegistry);
      
      const previousMcps = this.registry ? Object.keys(this.registry.mcps || {}) : [];
      const currentMcps = Object.keys(newRegistry.mcps || {});
      
      this.registry = newRegistry;
      this.metrics.registryReloads++;
      this.metrics.lastReload = new Date();
      
      // Update cache
      this.updateMcpCache();
      
      // Emit events for changes
      const added = currentMcps.filter(name => !previousMcps.includes(name));
      const removed = previousMcps.filter(name => !currentMcps.includes(name));
      const updated = currentMcps.filter(name => previousMcps.includes(name));
      
      if (added.length > 0) {
        this.emit('mcps_added', added);
        this.logger.info(`MCPs added: ${added.join(', ')}`);
      }
      
      if (removed.length > 0) {
        this.emit('mcps_removed', removed);
        this.logger.info(`MCPs removed: ${removed.join(', ')}`);
      }
      
      if (updated.length > 0) {
        this.emit('mcps_updated', updated);
        this.logger.debug(`MCPs updated: ${updated.join(', ')}`);
      }
      
      this.emit('registry_loaded', this.registry);
      this.logger.info(`Registry loaded: ${currentMcps.length} MCPs`);
      
    } catch (error) {
      this.metrics.errors++;
      this.logger.error('Failed to load registry:', error);
      throw error;
    }
  }

  /**
   * Validate registry structure
   */
  validateRegistry(registry) {
    if (!registry || typeof registry !== 'object') {
      throw new Error('Registry must be an object');
    }
    
    if (!registry.mcps || typeof registry.mcps !== 'object') {
      throw new Error('Registry must have mcps object');
    }
    
    // Count total MCPs for logging
    const mcpCount = Object.keys(registry.mcps).length;
    console.log(`🔍 Validating registry with ${mcpCount} MCP services...`);
    
    if (mcpCount === 0) {
      console.warn('⚠️ Warning: Registry contains no MCP services');
    }
    
    // Validate each MCP
    for (const [name, mcp] of Object.entries(registry.mcps)) {
      // Log validation in debug mode only
      if (process.env.NODE_ENV === 'development' || process.env.DEBUG_REGISTRY) {
        console.log(`Validating MCP: ${name}`, {
          hasName: !!mcp.name,
          nameValue: mcp.name,
          hasVersion: !!mcp.version,
          versionValue: mcp.version,
          mcpStructure: Object.keys(mcp)
        });
      }
      
      if (!mcp || typeof mcp !== 'object') {
        throw new Error(`MCP ${name} is not a valid object`);
      }
      
      if (!mcp.name || typeof mcp.name !== 'string') {
        // Auto-fix missing name by using the key name as fallback
        if (!mcp.name) {
          console.warn(`⚠️ Auto-fixing missing name for MCP ${name}`);
          mcp.name = name;
        } else {
          throw new Error(`MCP ${name} missing required name field (found: ${typeof mcp.name}: ${mcp.name})`);
        }
      }
      
      if (!mcp.version || typeof mcp.version !== 'string') {
        // Auto-fix missing version with default
        if (!mcp.version) {
          console.warn(`⚠️ Auto-fixing missing version for MCP ${name}`);
          mcp.version = '1.0.0';
        } else {
          throw new Error(`MCP ${name} missing required version field (found: ${typeof mcp.version}: ${mcp.version})`);
        }
      }
      
      if (!mcp.endpoints || typeof mcp.endpoints !== 'object' || Object.keys(mcp.endpoints).length === 0) {
        throw new Error(`MCP ${name} must have at least one endpoint (found: ${typeof mcp.endpoints})`);
      }
      
      if (!Array.isArray(mcp.capabilities)) {
        throw new Error(`MCP ${name} capabilities must be an array (found: ${typeof mcp.capabilities})`);
      }
      
      if (!Array.isArray(mcp.tools)) {
        throw new Error(`MCP ${name} tools must be an array (found: ${typeof mcp.tools})`);
      }
    }
  }

  /**
   * Update MCP cache with current registry
   */
  updateMcpCache() {
    const environment = this.options.environment;
    const envConfig = this.registry.environments?.[environment] || {};
    const globalConfig = this.registry.globalConfig || {};
    
    this.mcpCache.clear();
    
    for (const [name, mcp] of Object.entries(this.registry.mcps)) {
      // Merge configurations
      const mcpConfig = {
        ...mcp,
        ...envConfig,
        ...globalConfig,
        timestamp: Date.now()
      };
      
      // Resolve environment variables in endpoints
      if (mcpConfig.endpoints) {
        for (const endpoint of Object.values(mcpConfig.endpoints)) {
          if (endpoint.headers) {
            endpoint.headers = this.resolveEnvVars(endpoint.headers);
          }
        }
      }
      
      // Resolve authentication env vars
      if (mcpConfig.authentication) {
        mcpConfig.authentication = this.resolveEnvVars(mcpConfig.authentication);
      }
      
      this.mcpCache.set(name, mcpConfig);
    }
    
    this.metrics.mcpsDiscovered = this.mcpCache.size;
  }

  /**
   * Resolve environment variables in configuration
   */
  resolveEnvVars(obj) {
    const resolved = JSON.parse(JSON.stringify(obj));
    
    const traverse = (current) => {
      for (const [key, value] of Object.entries(current)) {
        if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
          const envVar = value.slice(2, -1);
          current[key] = process.env[envVar] || value;
        } else if (typeof value === 'object' && value !== null) {
          traverse(value);
        }
      }
    };
    
    traverse(resolved);
    return resolved;
  }

  /**
   * Start file watcher for registry changes
   */
  async startFileWatcher() {
    let debounceTimer;
    
    try {
      const watcher = fs.watchFile || require('chokidar').watch;
      
      if (typeof watcher === 'function') {
        // Use chokidar if available
        const chokidarWatcher = require('chokidar').watch(this.options.registryPath, {
          persistent: true,
          ignoreInitial: true
        });
        
        chokidarWatcher.on('change', () => {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(async () => {
            try {
              this.logger.info('Registry file changed, reloading...');
              await this.loadRegistry();
            } catch (error) {
              this.logger.error('Failed to reload registry:', error);
            }
          }, this.options.watchDebounceMs);
        });
        
        this.watchers.set('file', chokidarWatcher);
      } else {
        // Fallback to fs.watchFile
        fs.watchFile(this.options.registryPath, (curr, prev) => {
          if (curr.mtime !== prev.mtime) {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(async () => {
              try {
                this.logger.info('Registry file changed, reloading...');
                await this.loadRegistry();
              } catch (error) {
                this.logger.error('Failed to reload registry:', error);
              }
            }, this.options.watchDebounceMs);
          }
        });
        
        this.watchers.set('file', { close: () => fs.unwatchFile(this.options.registryPath) });
      }
      
      this.logger.info('File watcher started');
      
    } catch (error) {
      this.logger.warn('File watcher not available, falling back to polling');
      
      // Fallback to periodic polling
      const pollInterval = setInterval(async () => {
        try {
          const stats = await fs.stat(this.options.registryPath);
          const lastModified = stats.mtime.getTime();
          
          if (!this.lastModified || lastModified > this.lastModified) {
            this.lastModified = lastModified;
            await this.loadRegistry();
          }
        } catch (error) {
          this.logger.error('Registry polling error:', error);
        }
      }, 10000);
      
      this.watchers.set('file', { close: () => clearInterval(pollInterval) });
    }
  }

  /**
   * Start discovery methods based on environment
   */
  async startDiscoveryMethods() {
    const envConfig = this.registry.environments?.[this.options.environment] || {};
    const methods = envConfig.discoveryMethods || ['file'];
    
    for (const method of methods) {
      try {
        switch (method) {
          case 'env':
            await this.startEnvironmentDiscovery();
            break;
          case 'dns':
            await this.startDnsDiscovery();
            break;
          case 'multicast':
            await this.startMulticastDiscovery();
            break;
          case 'kubernetes':
            await this.startKubernetesDiscovery();
            break;
          default:
            this.logger.warn(`Unknown discovery method: ${method}`);
        }
      } catch (error) {
        this.logger.error(`Failed to start ${method} discovery:`, error);
      }
    }
  }

  /**
   * Environment variable discovery
   */
  async startEnvironmentDiscovery() {
    const mcpEnvVars = Object.keys(process.env).filter(key => 
      key.startsWith('MCP_') && key.endsWith('_ENDPOINT')
    );
    
    for (const envVar of mcpEnvVars) {
      const mcpName = envVar.replace('MCP_', '').replace('_ENDPOINT', '').toLowerCase();
      const endpoint = process.env[envVar];
      
      if (!this.mcpCache.has(mcpName)) {
        const discoveredMcp = {
          name: mcpName,
          version: '0.0.0',
          status: 'discovered',
          priority: 1,
          weight: 10,
          endpoints: {
            primary: {
              protocol: endpoint.startsWith('http') ? 'http' : 'stdio',
              url: endpoint.startsWith('http') ? endpoint : undefined,
              command: endpoint.startsWith('http') ? undefined : endpoint.split(' ')[0],
              args: endpoint.startsWith('http') ? undefined : endpoint.split(' ').slice(1),
              timeout: 30000,
              retries: 3
            }
          },
          capabilities: [],
          tools: [],
          dependencies: [],
          source: 'environment',
          timestamp: Date.now()
        };
        
        this.mcpCache.set(mcpName, discoveredMcp);
        this.emit('mcp_discovered', mcpName, discoveredMcp);
        this.logger.info(`Discovered MCP from environment: ${mcpName}`);
      }
    }
    
    this.logger.info('Environment discovery completed');
  }

  /**
   * DNS-based discovery using SRV records
   */
  async startDnsDiscovery() {
    try {
      const records = await dns.resolveSrv(this.options.dnsDiscoveryDomain);
      
      for (const record of records) {
        const mcpName = record.name.split('.')[0];
        const endpoint = `http://${record.target}:${record.port}`;
        
        if (!this.mcpCache.has(mcpName)) {
          const discoveredMcp = {
            name: mcpName,
            version: '0.0.0',
            status: 'discovered',
            priority: record.priority || 5,
            weight: record.weight || 50,
            endpoints: {
              primary: {
                protocol: 'http',
                url: endpoint,
                timeout: 30000,
                retries: 3
              }
            },
            capabilities: [],
            tools: [],
            dependencies: [],
            source: 'dns',
            timestamp: Date.now()
          };
          
          this.mcpCache.set(mcpName, discoveredMcp);
          this.emit('mcp_discovered', mcpName, discoveredMcp);
          this.logger.info(`Discovered MCP from DNS: ${mcpName} at ${endpoint}`);
        }
      }
      
      this.logger.info(`DNS discovery completed: ${records.length} records found`);
      
    } catch (error) {
      this.logger.warn('DNS discovery failed:', error.message);
    }
  }

  /**
   * Multicast discovery for local development
   */
  async startMulticastDiscovery() {
    try {
      this.multicastSocket = dgram.createSocket('udp4');
      
      this.multicastSocket.on('message', (msg, rinfo) => {
        try {
          const announcement = JSON.parse(msg.toString());
          
          if (announcement.type === 'mcp_announcement' && announcement.name) {
            const mcpName = announcement.name;
            
            if (!this.mcpCache.has(mcpName)) {
              const discoveredMcp = {
                ...announcement,
                source: 'multicast',
                timestamp: Date.now(),
                endpoints: {
                  primary: {
                    protocol: announcement.protocol || 'http',
                    url: announcement.url || `http://${rinfo.address}:${announcement.port}`,
                    timeout: 30000,
                    retries: 3
                  }
                }
              };
              
              this.mcpCache.set(mcpName, discoveredMcp);
              this.emit('mcp_discovered', mcpName, discoveredMcp);
              this.logger.info(`Discovered MCP via multicast: ${mcpName} from ${rinfo.address}`);
            }
          }
        } catch (error) {
          this.logger.warn('Invalid multicast message:', error.message);
        }
      });
      
      this.multicastSocket.bind(this.options.multicastPort, () => {
        this.multicastSocket.addMembership(this.options.multicastAddress);
        this.logger.info(`Multicast discovery listening on ${this.options.multicastAddress}:${this.options.multicastPort}`);
      });
      
    } catch (error) {
      this.logger.error('Failed to start multicast discovery:', error);
    }
  }

  /**
   * Kubernetes service discovery
   */
  async startKubernetesDiscovery() {
    try {
      // Check if running in Kubernetes
      if (!process.env.KUBERNETES_SERVICE_HOST) {
        this.logger.warn('Not running in Kubernetes, skipping k8s discovery');
        return;
      }
      
      const k8s = require('@kubernetes/client-node');
      const kc = new k8s.KubeConfig();
      kc.loadFromCluster();
      
      const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
      
      // Watch for services with MCP labels
      const labelSelector = 'type=mcp';
      const services = await k8sApi.listNamespacedService(
        this.options.kubernetesNamespace,
        undefined,
        undefined,
        undefined,
        undefined,
        labelSelector
      );
      
      for (const service of services.body.items) {
        const mcpName = service.metadata.labels?.['mcp-name'] || service.metadata.name;
        const port = service.spec.ports?.[0]?.port || 80;
        const endpoint = `http://${service.metadata.name}.${this.options.kubernetesNamespace}.svc.cluster.local:${port}`;
        
        if (!this.mcpCache.has(mcpName)) {
          const discoveredMcp = {
            name: mcpName,
            version: service.metadata.labels?.version || '0.0.0',
            status: 'discovered',
            priority: parseInt(service.metadata.labels?.priority) || 5,
            weight: parseInt(service.metadata.labels?.weight) || 50,
            endpoints: {
              primary: {
                protocol: 'http',
                url: endpoint,
                timeout: 30000,
                retries: 3
              }
            },
            capabilities: service.metadata.labels?.capabilities?.split(',') || [],
            tools: service.metadata.labels?.tools?.split(',') || [],
            dependencies: [],
            source: 'kubernetes',
            namespace: this.options.kubernetesNamespace,
            timestamp: Date.now()
          };
          
          this.mcpCache.set(mcpName, discoveredMcp);
          this.emit('mcp_discovered', mcpName, discoveredMcp);
          this.logger.info(`Discovered MCP from Kubernetes: ${mcpName} at ${endpoint}`);
        }
      }
      
      this.logger.info(`Kubernetes discovery completed: ${services.body.items.length} services found`);
      
    } catch (error) {
      this.logger.warn('Kubernetes discovery failed:', error.message);
    }
  }

  /**
   * Start health checking for discovered MCPs
   */
  startHealthChecking() {
    const interval = this.options.healthCheckInterval;
    
    const healthCheckInterval = setInterval(async () => {
      if (this.isShuttingDown) return;
      
      const healthChecks = [];
      
      for (const [name, mcp] of this.mcpCache.entries()) {
        if (mcp.healthCheck?.enabled) {
          healthChecks.push(this.performHealthCheck(name, mcp));
        }
      }
      
      if (healthChecks.length > 0) {
        await Promise.allSettled(healthChecks);
      }
    }, interval);
    
    this.healthCheckers.set('main', { interval: healthCheckInterval });
    this.logger.info(`Health checking started (interval: ${interval}ms)`);
  }

  /**
   * Perform health check on a single MCP
   */
  async performHealthCheck(name, mcp) {
    try {
      this.metrics.healthChecks++;
      
      const healthConfig = mcp.healthCheck;
      const timeout = healthConfig.timeout || 5000;
      
      let isHealthy = false;
      
      if (healthConfig.endpoint) {
        // HTTP health check
        const endpoint = mcp.endpoints.primary;
        if (endpoint.protocol === 'http') {
          const url = `${endpoint.url}${healthConfig.endpoint}`;
          const response = await this.makeHttpRequest('GET', url, null, timeout);
          isHealthy = response.status >= 200 && response.status < 300;
        }
      } else if (healthConfig.method === 'tool_call') {
        // Tool call health check
        isHealthy = await this.performToolHealthCheck(name, mcp, healthConfig);
      }
      
      // Update MCP status
      const currentMcp = this.mcpCache.get(name);
      if (currentMcp) {
        currentMcp.lastHealthCheck = new Date();
        currentMcp.healthy = isHealthy;
        
        if (!isHealthy) {
          this.metrics.healthCheckFailures++;
          this.emit('mcp_unhealthy', name, mcp);
        }
      }
      
    } catch (error) {
      this.metrics.healthCheckFailures++;
      const currentMcp = this.mcpCache.get(name);
      if (currentMcp) {
        currentMcp.lastHealthCheck = new Date();
        currentMcp.healthy = false;
        currentMcp.lastError = error.message;
      }
      
      this.emit('mcp_unhealthy', name, error);
      this.logger.warn(`Health check failed for ${name}:`, error.message);
    }
  }

  /**
   * Perform tool-based health check
   */
  async performToolHealthCheck(name, mcp, healthConfig) {
    // This would require the MCP client to be available
    // For now, return true as a placeholder
    return true;
  }

  /**
   * Make HTTP request with timeout
   */
  async makeHttpRequest(method, url, data, timeout = 5000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    try {
      const fetch = require('node-fetch');
      const response = await fetch(url, {
        method,
        body: data ? JSON.stringify(data) : undefined,
        headers: {
          'Content-Type': 'application/json'
        },
        signal: controller.signal
      });
      
      return {
        status: response.status,
        data: await response.text()
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Get all discovered MCPs
   */
  getMcps() {
    return Array.from(this.mcpCache.values());
  }

  /**
   * Get specific MCP by name
   */
  getMcp(name) {
    return this.mcpCache.get(name);
  }

  /**
   * Get MCPs by capability
   */
  getMcpsByCapability(capability) {
    return Array.from(this.mcpCache.values()).filter(mcp => 
      mcp.capabilities.includes(capability)
    );
  }

  /**
   * Get MCPs by tool
   */
  getMcpsByTool(tool) {
    return Array.from(this.mcpCache.values()).filter(mcp => 
      mcp.tools.includes(tool)
    );
  }

  /**
   * Get healthy MCPs only
   */
  getHealthyMcps() {
    return Array.from(this.mcpCache.values()).filter(mcp => 
      mcp.healthy !== false
    );
  }

  /**
   * Get metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      activeMcps: this.mcpCache.size,
      healthyMcps: this.getHealthyMcps().length,
      uptime: process.uptime()
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    this.isShuttingDown = true;
    this.logger.info('Shutting down discovery service...');
    
    // Close watchers
    for (const watcher of this.watchers.values()) {
      try {
        if (watcher.close) await watcher.close();
      } catch (error) {
        this.logger.warn('Error closing watcher:', error);
      }
    }
    
    // Close health checkers
    for (const checker of this.healthCheckers.values()) {
      if (checker.interval) clearInterval(checker.interval);
    }
    
    // Close multicast socket
    if (this.multicastSocket) {
      this.multicastSocket.close();
    }
    
    this.emit('shutdown');
    this.logger.info('Discovery service shut down');
  }
}

module.exports = MCPDiscoveryService;