const MCPDiscoveryService = require('./discovery-service');
const { OrchestrationEngine } = require('./orchestration-engine');
const path = require('path');

/**
 * Complete example of setting up and using the MCP Orchestration System
 */
class OrchestrationExample {
  constructor() {
    this.discoveryService = null;
    this.orchestrationEngine = null;
    this.logger = console;
  }

  /**
   * Initialize the complete orchestration system
   */
  async initialize() {
    try {
      this.logger.info('🚀 Initializing MCP Orchestration System...');

      // 1. Initialize Discovery Service
      this.discoveryService = new MCPDiscoveryService({
        registryPath: path.join(__dirname, 'mcp-registry.json'),
        environment: process.env.NODE_ENV || 'development',
        logger: this.logger
      });

      await this.discoveryService.initialize();
      this.logger.info('✅ Discovery Service initialized');

      // 2. Initialize Orchestration Engine
      this.orchestrationEngine = new OrchestrationEngine(this.discoveryService, {
        maxConcurrentWorkflows: 50,
        maxConcurrentSteps: 20,
        logger: this.logger
      });

      // 3. Setup event listeners
      this.setupEventListeners();

      // 4. Load workflow definitions
      await this.loadWorkflows();

      this.logger.info('🎯 Orchestration System ready!');
      this.printSystemStatus();

    } catch (error) {
      this.logger.error('❌ Failed to initialize orchestration system:', error);
      throw error;
    }
  }

  /**
   * Setup comprehensive event listeners for monitoring
   */
  setupEventListeners() {
    // Discovery Service Events
    this.discoveryService.on('registry_loaded', (registry) => {
      this.logger.info(`📋 Registry loaded: ${Object.keys(registry.mcps).length} MCPs`);
    });

    this.discoveryService.on('mcp_discovered', (name, mcp) => {
      this.logger.info(`🔍 Discovered MCP: ${name} from ${mcp.source}`);
    });

    this.discoveryService.on('mcp_unhealthy', (name, error) => {
      this.logger.warn(`⚠️  MCP unhealthy: ${name} - ${error.message || error}`);
    });

    // Orchestration Engine Events
    this.orchestrationEngine.on('workflow_started', (context) => {
      this.logger.info(`🏃 Workflow started: ${context.workflow.name} (${context.workflowId})`);
    });

    this.orchestrationEngine.on('workflow_completed', (context) => {
      const duration = context.endTime - context.startTime;
      this.logger.info(`✅ Workflow completed: ${context.workflow.name} (${context.workflowId}) in ${duration}ms - ${context.state}`);
    });

    this.orchestrationEngine.on('step_started', (context, step) => {
      this.logger.debug(`   🔸 Step started: ${step.name} via ${step.mcp}`);
    });

    this.orchestrationEngine.on('step_completed', (context, step, result) => {
      this.logger.debug(`   ✅ Step completed: ${step.name}`);
    });

    this.orchestrationEngine.on('step_failed', (context, step, error) => {
      this.logger.warn(`   ❌ Step failed: ${step.name} - ${error.message}`);
    });

    this.orchestrationEngine.on('workflow_compensation_started', (context) => {
      this.logger.warn(`🔄 Starting compensation for workflow: ${context.workflowId}`);
    });

    this.orchestrationEngine.on('mcp_client_added', (name, client) => {
      this.logger.info(`🔗 MCP client connected: ${name}`);
    });

    this.orchestrationEngine.on('circuit_breaker_state_change', (state) => {
      this.logger.info(`🔌 Circuit breaker state changed: ${state}`);
    });
  }

  /**
   * Load workflow definitions
   */
  async loadWorkflows() {
    try {
      // Load the example workflow
      const workflow = await this.orchestrationEngine.loadWorkflowFromFile(
        path.join(__dirname, 'example-workflow.yaml')
      );
      this.logger.info(`📝 Loaded workflow: ${workflow.name} v${workflow.version}`);

      // Register additional programmatic workflows
      this.registerAdditionalWorkflows();

    } catch (error) {
      this.logger.error('Failed to load workflows:', error);
      throw error;
    }
  }

  /**
   * Register additional workflows programmatically
   */
  registerAdditionalWorkflows() {
    // Simple health check workflow
    const healthCheckWorkflow = {
      name: 'health_check_all_mcps',
      version: '1.0.0',
      description: 'Check health of all registered MCPs',
      timeout: 60000,
      steps: [
        {
          name: 'check_main_platform',
          mcp: 'main-platform',
          action: 'health_check',
          params: {},
          timeout: 10000,
          retries: 1,
          critical: false
        },
        {
          name: 'check_google_workspace',
          mcp: 'google-workspace',
          action: 'health_check',
          params: {},
          timeout: 15000,
          retries: 1,
          critical: false,
          parallel: true
        },
        {
          name: 'check_textbee',
          mcp: 'textbee',
          action: 'health_check',
          params: {},
          timeout: 10000,
          retries: 1,
          critical: false,
          parallel: true
        }
      ]
    };

    this.orchestrationEngine.registerWorkflow(healthCheckWorkflow);

    // Bulk communication workflow
    const bulkCommunicationWorkflow = {
      name: 'send_bulk_notifications',
      version: '1.0.0',
      description: 'Send notifications to multiple contacts',
      timeout: 600000, // 10 minutes
      steps: [
        {
          name: 'validate_contacts',
          mcp: 'main-platform',
          action: 'validate_contact_list',
          params: {
            contact_ids: '$input.contact_ids'
          },
          timeout: 30000,
          retries: 1,
          critical: true
        },
        {
          name: 'get_coach_info',
          mcp: 'main-platform',
          action: 'get_coach',
          params: {
            coach_id: '$input.coach_id'
          },
          timeout: 10000,
          retries: 1,
          critical: true,
          parallel: true
        },
        {
          name: 'prepare_messages',
          mcp: 'main-platform',
          action: 'prepare_bulk_messages',
          params: {
            contacts: '$steps.validate_contacts.result.valid_contacts',
            coach: '$steps.get_coach_info.result',
            template: '$input.message_template'
          },
          timeout: 30000,
          retries: 1,
          critical: true,
          dependsOn: ['validate_contacts', 'get_coach_info']
        },
        {
          name: 'send_messages',
          mcp: 'textbee',
          action: 'send_bulk',
          params: {
            messages: '$steps.prepare_messages.result.messages',
            from: '$steps.get_coach_info.result.phone'
          },
          timeout: 120000,
          retries: 2,
          critical: true,
          dependsOn: ['prepare_messages']
        },
        {
          name: 'log_bulk_activity',
          mcp: 'main-platform',
          action: 'log_bulk_communication',
          params: {
            type: 'sms',
            coach_id: '$input.coach_id',
            contact_ids: '$input.contact_ids',
            results: '$steps.send_messages.result',
            workflow_id: '$workflowId'
          },
          timeout: 30000,
          retries: 2,
          critical: false,
          dependsOn: ['send_messages']
        }
      ]
    };

    this.orchestrationEngine.registerWorkflow(bulkCommunicationWorkflow);
    this.logger.info('📝 Registered additional workflows');
  }

  /**
   * Example: Execute a simple SMS workflow
   */
  async sendCoachedSMS(phone, coachId, message) {
    try {
      this.logger.info(`📤 Sending coached SMS to ${phone}...`);

      const result = await this.orchestrationEngine.executeWorkflow('send_coached_sms', {
        phone: phone,
        coach_id: coachId,
        message: message
      }, {
        metadata: {
          source: 'api',
          user_id: 'example-user'
        }
      });

      this.logger.info('✅ SMS workflow completed:', result);
      return result;

    } catch (error) {
      this.logger.error('❌ SMS workflow failed:', error);
      throw error;
    }
  }

  /**
   * Example: Execute health check workflow
   */
  async performHealthCheck() {
    try {
      this.logger.info('🏥 Performing system health check...');

      const result = await this.orchestrationEngine.executeWorkflow('health_check_all_mcps');
      
      this.logger.info('✅ Health check completed:', result);
      return result;

    } catch (error) {
      this.logger.error('❌ Health check failed:', error);
      throw error;
    }
  }

  /**
   * Example: Execute bulk communication workflow
   */
  async sendBulkNotifications(contactIds, coachId, messageTemplate) {
    try {
      this.logger.info(`📢 Sending bulk notifications to ${contactIds.length} contacts...`);

      const result = await this.orchestrationEngine.executeWorkflow('send_bulk_notifications', {
        contact_ids: contactIds,
        coach_id: coachId,
        message_template: messageTemplate
      });

      this.logger.info('✅ Bulk notification workflow completed:', result);
      return result;

    } catch (error) {
      this.logger.error('❌ Bulk notification workflow failed:', error);
      throw error;
    }
  }

  /**
   * Monitor workflow execution
   */
  async monitorWorkflow(workflowId) {
    try {
      const status = this.orchestrationEngine.getWorkflowStatus(workflowId);
      this.logger.info(`📊 Workflow Status (${workflowId}):`, status);
      return status;
    } catch (error) {
      this.logger.error(`Failed to get workflow status: ${error.message}`);
      throw error;
    }
  }

  /**
   * List all active workflows
   */
  listActiveWorkflows() {
    const active = this.orchestrationEngine.listActiveExecutions();
    this.logger.info(`📋 Active Workflows: ${active.length}`);
    active.forEach(workflow => {
      this.logger.info(`  - ${workflow.workflowName} (${workflow.workflowId}) - ${workflow.state}`);
      this.logger.info(`    Progress: ${workflow.completedSteps}/${workflow.totalSteps} steps`);
    });
    return active;
  }

  /**
   * Get comprehensive system metrics
   */
  getSystemMetrics() {
    const discoveryMetrics = this.discoveryService.getMetrics();
    const engineMetrics = this.orchestrationEngine.getMetrics();
    
    const metrics = {
      discovery: discoveryMetrics,
      orchestration: engineMetrics,
      timestamp: new Date()
    };

    this.logger.info('📈 System Metrics:', metrics);
    return metrics;
  }

  /**
   * Print current system status
   */
  printSystemStatus() {
    console.log('\n🎯 MCP Orchestration System Status');
    console.log('=====================================');
    
    // MCPs Status
    const mcps = this.discoveryService.getMcps();
    console.log(`📡 Discovered MCPs: ${mcps.length}`);
    mcps.forEach(mcp => {
      const healthIcon = mcp.healthy !== false ? '✅' : '❌';
      console.log(`  ${healthIcon} ${mcp.name} v${mcp.version} (${mcp.source})`);
    });

    // Workflows Status
    const workflows = this.orchestrationEngine.listWorkflows();
    console.log(`\n📝 Registered Workflows: ${workflows.length}`);
    workflows.forEach(workflow => {
      console.log(`  📋 ${workflow.name} v${workflow.version} (${workflow.stepCount} steps)`);
    });

    // Active Executions
    const active = this.orchestrationEngine.listActiveExecutions();
    console.log(`\n🏃 Active Executions: ${active.length}`);
    if (active.length > 0) {
      active.forEach(exec => {
        console.log(`  ⏳ ${exec.workflowName} - ${exec.completedSteps}/${exec.totalSteps} steps`);
      });
    }

    console.log('\n🚀 System ready for orchestration!\n');
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    this.logger.info('🛑 Shutting down orchestration system...');
    
    if (this.orchestrationEngine) {
      await this.orchestrationEngine.shutdown();
    }
    
    if (this.discoveryService) {
      await this.discoveryService.shutdown();
    }
    
    this.logger.info('👋 Orchestration system shut down gracefully');
  }
}

/**
 * Example usage and demonstration
 */
async function main() {
  const example = new OrchestrationExample();
  
  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n🛑 Received shutdown signal...');
    await example.shutdown();
    process.exit(0);
  });

  try {
    // Initialize system
    await example.initialize();

    // Wait a bit for MCPs to connect
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Example 1: Send a coached SMS
    console.log('\n📤 Example 1: Sending Coached SMS');
    console.log('==================================');
    try {
      const smsResult = await example.sendCoachedSMS(
        '+1234567890',
        'coach-123',
        'Hi ${contact_name}, this is ${coach_name} from ${organization}. Hope you\'re doing well!'
      );
      console.log('SMS Result:', smsResult);
    } catch (error) {
      console.log('SMS Error:', error.message);
    }

    // Example 2: Health check
    console.log('\n🏥 Example 2: System Health Check');
    console.log('=================================');
    try {
      const healthResult = await example.performHealthCheck();
      console.log('Health Check Result:', healthResult);
    } catch (error) {
      console.log('Health Check Error:', error.message);
    }

    // Example 3: Monitor system
    console.log('\n📊 Example 3: System Monitoring');
    console.log('==============================');
    example.listActiveWorkflows();
    example.getSystemMetrics();

    // Example 4: Bulk notifications (with mock data)
    console.log('\n📢 Example 4: Bulk Notifications');
    console.log('================================');
    try {
      const bulkResult = await example.sendBulkNotifications(
        ['contact-1', 'contact-2', 'contact-3'],
        'coach-123',
        'Team practice has been moved to ${new_time}. Please confirm attendance.'
      );
      console.log('Bulk Notification Result:', bulkResult);
    } catch (error) {
      console.log('Bulk Notification Error:', error.message);
    }

  } catch (error) {
    console.error('❌ Example failed:', error);
    await example.shutdown();
    process.exit(1);
  }
}

// Export for use in other modules
module.exports = {
  OrchestrationExample,
  main
};

// Run example if this file is executed directly
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}