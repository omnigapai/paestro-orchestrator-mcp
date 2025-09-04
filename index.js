#!/usr/bin/env node

/**
 * MCP Orchestration System - Main Entry Point
 * 
 * This is the primary entry point for the MCP orchestration system.
 * It provides both programmatic API and CLI functionality.
 */

const MCPDiscoveryService = require('./discovery-service');
const { OrchestrationEngine, WorkflowState } = require('./orchestration-engine');
const { MCPClient, CircuitBreakerState } = require('./mcp-client');
const path = require('path');
const fs = require('fs').promises;

/**
 * Main Orchestrator Class
 * Combines discovery service and orchestration engine
 */
class MCPOrchestrator {
  constructor(options = {}) {
    this.options = {
      registryPath: options.registryPath || path.join(__dirname, 'mcp-registry.json'),
      environment: options.environment || process.env.NODE_ENV || 'development',
      workflowsDir: options.workflowsDir || path.join(__dirname, 'workflows'),
      maxConcurrentWorkflows: options.maxConcurrentWorkflows || 100,
      maxConcurrentSteps: options.maxConcurrentSteps || 50,
      logger: options.logger || console,
      ...options
    };

    this.discoveryService = null;
    this.orchestrationEngine = null;
    this.logger = this.options.logger;
    this.isInitialized = false;
    this.shutdownInProgress = false;
  }

  /**
   * Initialize the orchestrator system
   */
  async initialize() {
    if (this.isInitialized) {
      throw new Error('Orchestrator already initialized');
    }

    try {
      this.logger.info('🚀 Initializing MCP Orchestrator...');

      // 1. Initialize Discovery Service
      this.discoveryService = new MCPDiscoveryService({
        registryPath: this.options.registryPath,
        environment: this.options.environment,
        logger: this.logger,
        ...this.options
      });

      await this.discoveryService.initialize();

      // 2. Initialize Orchestration Engine
      this.orchestrationEngine = new OrchestrationEngine(this.discoveryService, {
        maxConcurrentWorkflows: this.options.maxConcurrentWorkflows,
        maxConcurrentSteps: this.options.maxConcurrentSteps,
        logger: this.logger,
        ...this.options
      });

      // 3. Load workflows from directory
      if (await this.directoryExists(this.options.workflowsDir)) {
        await this.loadWorkflowsFromDirectory();
      }

      this.isInitialized = true;
      this.logger.info('✅ MCP Orchestrator initialized successfully');

      // Setup graceful shutdown
      this.setupGracefulShutdown();

      return this;
    } catch (error) {
      this.logger.error('❌ Failed to initialize MCP Orchestrator:', error);
      throw error;
    }
  }

  /**
   * Load all workflows from workflows directory
   */
  async loadWorkflowsFromDirectory() {
    try {
      const files = await fs.readdir(this.options.workflowsDir);
      const workflowFiles = files.filter(file => 
        file.endsWith('.yaml') || file.endsWith('.yml') || file.endsWith('.json')
      );

      this.logger.info(`📁 Loading ${workflowFiles.length} workflow files...`);

      for (const file of workflowFiles) {
        try {
          const filePath = path.join(this.options.workflowsDir, file);
          await this.orchestrationEngine.loadWorkflowFromFile(filePath);
          this.logger.debug(`✅ Loaded workflow: ${file}`);
        } catch (error) {
          this.logger.error(`❌ Failed to load workflow ${file}:`, error.message);
        }
      }

      this.logger.info('📝 Workflow loading complete');
    } catch (error) {
      this.logger.warn('⚠️  Could not load workflows from directory:', error.message);
    }
  }

  /**
   * Check if directory exists
   */
  async directoryExists(dirPath) {
    try {
      const stats = await fs.stat(dirPath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Execute workflow by name
   */
  async executeWorkflow(workflowName, input = {}, options = {}) {
    if (!this.isInitialized) {
      throw new Error('Orchestrator not initialized. Call initialize() first.');
    }

    return await this.orchestrationEngine.executeWorkflow(workflowName, input, options);
  }

  /**
   * Register a new workflow
   */
  registerWorkflow(definition) {
    if (!this.isInitialized) {
      throw new Error('Orchestrator not initialized. Call initialize() first.');
    }

    return this.orchestrationEngine.registerWorkflow(definition);
  }

  /**
   * Load workflow from file
   */
  async loadWorkflowFromFile(filePath) {
    if (!this.isInitialized) {
      throw new Error('Orchestrator not initialized. Call initialize() first.');
    }

    return await this.orchestrationEngine.loadWorkflowFromFile(filePath);
  }

  /**
   * Get workflow execution status
   */
  getWorkflowStatus(workflowId) {
    if (!this.isInitialized) {
      throw new Error('Orchestrator not initialized');
    }

    return this.orchestrationEngine.getWorkflowStatus(workflowId);
  }

  /**
   * Cancel workflow execution
   */
  async cancelWorkflow(workflowId, reason = 'cancelled') {
    if (!this.isInitialized) {
      throw new Error('Orchestrator not initialized');
    }

    return await this.orchestrationEngine.cancelWorkflow(workflowId, reason);
  }

  /**
   * List all registered workflows
   */
  listWorkflows() {
    if (!this.isInitialized) {
      return [];
    }

    return this.orchestrationEngine.listWorkflows();
  }

  /**
   * List active workflow executions
   */
  listActiveExecutions() {
    if (!this.isInitialized) {
      return [];
    }

    return this.orchestrationEngine.listActiveExecutions();
  }

  /**
   * Get discovered MCPs
   */
  getMcps() {
    if (!this.isInitialized) {
      return [];
    }

    return this.discoveryService.getMcps();
  }

  /**
   * Get MCP by name
   */
  getMcp(name) {
    if (!this.isInitialized) {
      return null;
    }

    return this.discoveryService.getMcp(name);
  }

  /**
   * Get comprehensive system metrics
   */
  getMetrics() {
    if (!this.isInitialized) {
      return { error: 'Orchestrator not initialized' };
    }

    const discoveryMetrics = this.discoveryService.getMetrics();
    const orchestrationMetrics = this.orchestrationEngine.getMetrics();

    return {
      timestamp: new Date(),
      uptime: process.uptime(),
      discovery: discoveryMetrics,
      orchestration: orchestrationMetrics,
      system: {
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        memoryUsage: process.memoryUsage(),
        cpuUsage: process.cpuUsage()
      }
    };
  }

  /**
   * Perform system health check
   */
  async healthCheck() {
    if (!this.isInitialized) {
      return {
        status: 'unhealthy',
        reason: 'Not initialized'
      };
    }

    try {
      // Check discovery service
      const mcps = this.discoveryService.getMcps();
      const healthyMcps = mcps.filter(mcp => mcp.healthy !== false);
      
      // Check orchestration engine
      const activeExecutions = this.orchestrationEngine.listActiveExecutions();
      const metrics = this.orchestrationEngine.getMetrics();

      const health = {
        status: 'healthy',
        timestamp: new Date(),
        components: {
          discoveryService: {
            status: 'healthy',
            mcpsDiscovered: mcps.length,
            healthyMcps: healthyMcps.length
          },
          orchestrationEngine: {
            status: 'healthy',
            activeExecutions: activeExecutions.length,
            totalWorkflows: metrics.totalWorkflows,
            registeredWorkflows: metrics.registeredWorkflows
          }
        },
        checks: {
          mcpConnectivity: healthyMcps.length > 0 ? 'pass' : 'warn',
          systemResources: this.checkSystemResources(),
          workflowCapacity: activeExecutions.length < this.options.maxConcurrentWorkflows ? 'pass' : 'warn'
        }
      };

      // Determine overall status
      const hasWarnings = Object.values(health.checks).includes('warn');
      const hasFailures = Object.values(health.checks).includes('fail');
      
      if (hasFailures) {
        health.status = 'unhealthy';
      } else if (hasWarnings) {
        health.status = 'degraded';
      }

      return health;
    } catch (error) {
      return {
        status: 'unhealthy',
        reason: error.message,
        timestamp: new Date()
      };
    }
  }

  /**
   * Check system resource utilization
   */
  checkSystemResources() {
    try {
      const memUsage = process.memoryUsage();
      const memUsageMB = memUsage.heapUsed / 1024 / 1024;
      
      // Warning if using more than 500MB
      if (memUsageMB > 500) {
        return 'warn';
      }
      
      // Fail if using more than 1GB
      if (memUsageMB > 1024) {
        return 'fail';
      }
      
      return 'pass';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Setup graceful shutdown handlers
   */
  setupGracefulShutdown() {
    const shutdown = async (signal) => {
      if (this.shutdownInProgress) {
        this.logger.warn(`Received ${signal} signal during shutdown, forcing exit...`);
        process.exit(1);
      }

      this.shutdownInProgress = true;
      this.logger.info(`🛑 Received ${signal} signal, starting graceful shutdown...`);

      try {
        await this.shutdown();
        this.logger.info('👋 Graceful shutdown completed');
        process.exit(0);
      } catch (error) {
        this.logger.error('❌ Error during shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    
    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      this.logger.error('❌ Uncaught Exception:', error);
      shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
      shutdown('unhandledRejection');
    });
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    if (!this.isInitialized) {
      return;
    }

    this.logger.info('🛑 Shutting down MCP Orchestrator...');

    try {
      // Shutdown orchestration engine first
      if (this.orchestrationEngine) {
        await this.orchestrationEngine.shutdown();
      }

      // Shutdown discovery service
      if (this.discoveryService) {
        await this.discoveryService.shutdown();
      }

      this.isInitialized = false;
      this.logger.info('✅ MCP Orchestrator shut down successfully');
    } catch (error) {
      this.logger.error('❌ Error during shutdown:', error);
      throw error;
    }
  }
}

/**
 * CLI Interface
 */
async function cli() {
  const args = process.argv.slice(2);
  const command = args[0];

  const orchestrator = new MCPOrchestrator({
    registryPath: process.env.MCP_REGISTRY_PATH || './mcp-registry.json',
    environment: process.env.NODE_ENV || 'development'
  });

  try {
    switch (command) {
      case 'start':
        await orchestrator.initialize();
        console.log('🚀 MCP Orchestrator started successfully');
        
        // Keep the process running
        process.on('SIGTERM', async () => {
          await orchestrator.shutdown();
          process.exit(0);
        });
        break;

      case 'health':
        await orchestrator.initialize();
        const health = await orchestrator.healthCheck();
        console.log(JSON.stringify(health, null, 2));
        process.exit(health.status === 'healthy' ? 0 : 1);
        break;

      case 'metrics':
        await orchestrator.initialize();
        const metrics = orchestrator.getMetrics();
        console.log(JSON.stringify(metrics, null, 2));
        break;

      case 'workflows':
        await orchestrator.initialize();
        const workflows = orchestrator.listWorkflows();
        console.log('📝 Registered Workflows:');
        workflows.forEach(workflow => {
          console.log(`  - ${workflow.name} v${workflow.version} (${workflow.stepCount} steps)`);
        });
        break;

      case 'mcps':
        await orchestrator.initialize();
        const mcps = orchestrator.getMcps();
        console.log('📡 Discovered MCPs:');
        mcps.forEach(mcp => {
          const healthIcon = mcp.healthy !== false ? '✅' : '❌';
          console.log(`  ${healthIcon} ${mcp.name} v${mcp.version} (${mcp.source})`);
        });
        break;

      case 'execute':
        if (!args[1]) {
          console.error('❌ Usage: execute <workflow-name> [input-json]');
          process.exit(1);
        }
        
        await orchestrator.initialize();
        const workflowName = args[1];
        const input = args[2] ? JSON.parse(args[2]) : {};
        
        console.log(`🏃 Executing workflow: ${workflowName}`);
        const result = await orchestrator.executeWorkflow(workflowName, input);
        console.log('✅ Execution result:', JSON.stringify(result, null, 2));
        break;

      case 'status':
        if (!args[1]) {
          console.error('❌ Usage: status <workflow-id>');
          process.exit(1);
        }
        
        await orchestrator.initialize();
        const workflowId = args[1];
        const status = orchestrator.getWorkflowStatus(workflowId);
        console.log('📊 Workflow Status:', JSON.stringify(status, null, 2));
        break;

      case 'cancel':
        if (!args[1]) {
          console.error('❌ Usage: cancel <workflow-id> [reason]');
          process.exit(1);
        }
        
        await orchestrator.initialize();
        const cancelWorkflowId = args[1];
        const reason = args[2] || 'manual_cancellation';
        
        await orchestrator.cancelWorkflow(cancelWorkflowId, reason);
        console.log(`🛑 Cancelled workflow: ${cancelWorkflowId}`);
        break;

      case 'validate':
        console.log('🔍 Validating configuration...');
        
        // Validate registry
        try {
          const registryPath = process.env.MCP_REGISTRY_PATH || './mcp-registry.json';
          const registryData = await fs.readFile(registryPath, 'utf8');
          JSON.parse(registryData);
          console.log('✅ Registry configuration valid');
        } catch (error) {
          console.error('❌ Registry validation failed:', error.message);
          process.exit(1);
        }
        
        // Try to initialize
        try {
          await orchestrator.initialize();
          console.log('✅ System initialization successful');
          await orchestrator.shutdown();
        } catch (error) {
          console.error('❌ System validation failed:', error.message);
          process.exit(1);
        }
        break;

      case 'help':
      case '--help':
      case '-h':
        console.log(`
🎯 MCP Orchestration System CLI

Usage: node index.js <command> [options]

Commands:
  start              Start the orchestrator service
  health             Check system health
  metrics            Show system metrics  
  workflows          List registered workflows
  mcps              List discovered MCPs
  execute <name> [input]  Execute workflow with optional JSON input
  status <id>        Show workflow execution status
  cancel <id> [reason]    Cancel workflow execution
  validate           Validate configuration
  help              Show this help message

Environment Variables:
  NODE_ENV                 Environment (development/production)
  MCP_REGISTRY_PATH        Path to MCP registry file
  MAX_CONCURRENT_WORKFLOWS Maximum concurrent workflows
  MAX_CONCURRENT_STEPS     Maximum concurrent steps per workflow
  LOG_LEVEL                Logging level (debug/info/warn/error)

Examples:
  node index.js start
  node index.js execute send_coached_sms '{"phone":"+1234567890","message":"Hello"}'
  node index.js health
  node index.js workflows
        `);
        break;

      default:
        console.error(`❌ Unknown command: ${command}`);
        console.log('Use "help" to see available commands');
        process.exit(1);
    }

    // Only shutdown if not in start mode (which should keep running)
    if (command !== 'start') {
      await orchestrator.shutdown();
    }

  } catch (error) {
    console.error('❌ Command failed:', error.message);
    if (process.env.NODE_ENV === 'development') {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Export for programmatic use
module.exports = {
  MCPOrchestrator,
  MCPDiscoveryService,
  OrchestrationEngine,
  MCPClient,
  WorkflowState,
  CircuitBreakerState
};

// CLI mode if run directly
if (require.main === module) {
  cli().catch(error => {
    console.error('❌ CLI error:', error);
    process.exit(1);
  });
}