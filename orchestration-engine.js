const EventEmitter = require('events');
const yaml = require('js-yaml');
const { v4: uuidv4 } = require('uuid');

/**
 * Workflow Execution States
 */
const WorkflowState = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING', 
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  COMPENSATING: 'COMPENSATING',
  COMPENSATED: 'COMPENSATED'
};

/**
 * Step Execution States
 */
const StepState = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
  COMPENSATING: 'COMPENSATING',
  COMPENSATED: 'COMPENSATED'
};

/**
 * Workflow Step Definition
 */
class WorkflowStep {
  constructor(definition) {
    this.name = definition.name;
    this.mcp = definition.mcp;
    this.action = definition.action;
    this.params = definition.params || {};
    this.timeout = definition.timeout || 30000;
    this.retries = definition.retries || 0;
    this.condition = definition.condition;
    this.compensation = definition.compensation;
    this.parallel = definition.parallel || false;
    this.critical = definition.critical !== false; // Default to true
    this.dependsOn = definition.dependsOn || [];
    
    // Runtime state
    this.state = StepState.PENDING;
    this.result = null;
    this.error = null;
    this.startTime = null;
    this.endTime = null;
    this.attempt = 0;
  }

  /**
   * Check if step can be executed
   */
  canExecute(context) {
    // Check dependencies
    for (const dep of this.dependsOn) {
      const depStep = context.steps[dep];
      if (!depStep || depStep.state !== StepState.COMPLETED) {
        return false;
      }
    }
    
    // Check condition
    if (this.condition) {
      return this.evaluateCondition(this.condition, context);
    }
    
    return true;
  }

  /**
   * Evaluate step condition
   */
  evaluateCondition(condition, context) {
    try {
      // Simple condition evaluation (can be extended)
      // Support for: $input.field, $steps.stepName.result, $context.field
      const evaluatedCondition = this.interpolateString(condition, context);
      return new Function('return ' + evaluatedCondition)();
    } catch (error) {
      return false;
    }
  }

  /**
   * Interpolate parameters with context values
   */
  interpolateParams(context) {
    const interpolated = JSON.parse(JSON.stringify(this.params));
    return this.interpolateObject(interpolated, context);
  }

  /**
   * Recursively interpolate object values
   */
  interpolateObject(obj, context) {
    if (typeof obj === 'string') {
      return this.interpolateString(obj, context);
    } else if (Array.isArray(obj)) {
      return obj.map(item => this.interpolateObject(item, context));
    } else if (typeof obj === 'object' && obj !== null) {
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.interpolateObject(value, context);
      }
      return result;
    }
    return obj;
  }

  /**
   * Interpolate string with context values
   */
  interpolateString(str, context) {
    if (typeof str !== 'string') return str;
    
    return str.replace(/\$\{([^}]+)\}/g, (match, path) => {
      const value = this.getNestedValue(context, path);
      return value !== undefined ? value : match;
    }).replace(/\$([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)/g, (match, path) => {
      const value = this.getNestedValue(context, path);
      return value !== undefined ? value : match;
    });
  }

  /**
   * Get nested value from object path
   */
  getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : undefined;
    }, obj);
  }
}

/**
 * Workflow Definition
 */
class Workflow {
  constructor(definition) {
    this.id = definition.id || uuidv4();
    this.name = definition.name;
    this.version = definition.version || '1.0.0';
    this.description = definition.description;
    this.timeout = definition.timeout || 300000; // 5 minutes default
    this.maxRetries = definition.maxRetries || 0;
    this.compensationStrategy = definition.compensationStrategy || 'reverse_order';
    
    // Parse steps
    this.steps = {};
    this.stepOrder = [];
    
    if (definition.steps) {
      for (const stepDef of definition.steps) {
        const step = new WorkflowStep(stepDef);
        this.steps[step.name] = step;
        this.stepOrder.push(step.name);
      }
    }
    
    // Validate workflow
    this.validate();
  }

  /**
   * Validate workflow definition
   */
  validate() {
    // Check for circular dependencies
    const visited = new Set();
    const recursionStack = new Set();
    
    const hasCycle = (stepName) => {
      if (recursionStack.has(stepName)) return true;
      if (visited.has(stepName)) return false;
      
      visited.add(stepName);
      recursionStack.add(stepName);
      
      const step = this.steps[stepName];
      for (const dep of step.dependsOn) {
        if (!this.steps[dep]) {
          throw new Error(`Step ${stepName} depends on non-existent step ${dep}`);
        }
        if (hasCycle(dep)) return true;
      }
      
      recursionStack.delete(stepName);
      return false;
    };
    
    for (const stepName of this.stepOrder) {
      if (hasCycle(stepName)) {
        throw new Error('Circular dependency detected in workflow');
      }
    }
  }

  /**
   * Get steps that can be executed in parallel
   */
  getExecutableSteps(context) {
    const executable = [];
    
    for (const stepName of this.stepOrder) {
      const step = this.steps[stepName];
      if (step.state === StepState.PENDING && step.canExecute(context)) {
        executable.push(step);
      }
    }
    
    return executable;
  }

  /**
   * Get steps for compensation in reverse dependency order
   */
  getCompensationOrder() {
    const completed = this.stepOrder.filter(name => 
      this.steps[name].state === StepState.COMPLETED && 
      this.steps[name].compensation
    );
    
    if (this.compensationStrategy === 'reverse_order') {
      return completed.reverse();
    }
    
    return completed;
  }
}

/**
 * Workflow Execution Context
 */
class WorkflowContext {
  constructor(workflow, input = {}) {
    this.workflowId = uuidv4();
    this.workflow = workflow;
    this.input = input;
    this.steps = {};
    this.state = WorkflowState.PENDING;
    this.result = null;
    this.error = null;
    this.startTime = null;
    this.endTime = null;
    this.attempt = 0;
    this.variables = {};
    this.metadata = {};
    
    // Initialize step contexts
    for (const [name, step] of Object.entries(workflow.steps)) {
      this.steps[name] = { ...step };
    }
  }

  /**
   * Set variable value
   */
  setVariable(key, value) {
    this.variables[key] = value;
  }

  /**
   * Get variable value
   */
  getVariable(key) {
    return this.variables[key];
  }

  /**
   * Set step result
   */
  setStepResult(stepName, result) {
    if (this.steps[stepName]) {
      this.steps[stepName].result = result;
    }
  }

  /**
   * Get step result
   */
  getStepResult(stepName) {
    return this.steps[stepName]?.result;
  }
}

/**
 * Orchestration Engine
 */
class OrchestrationEngine extends EventEmitter {
  constructor(discoveryService, options = {}) {
    super();
    
    this.discoveryService = discoveryService;
    this.options = {
      maxConcurrentWorkflows: options.maxConcurrentWorkflows || 100,
      maxConcurrentSteps: options.maxConcurrentSteps || 50,
      defaultTimeout: options.defaultTimeout || 300000,
      heartbeatInterval: options.heartbeatInterval || 5000,
      cleanupInterval: options.cleanupInterval || 60000,
      persistenceEnabled: options.persistenceEnabled || false,
      ...options
    };
    
    this.logger = options.logger || console;
    this.mcpClients = new Map(); // MCP name -> MCPClient
    this.workflows = new Map(); // workflow ID -> Workflow
    this.activeExecutions = new Map(); // execution ID -> WorkflowContext
    this.executionHistory = new Map(); // execution ID -> WorkflowContext (completed)
    
    // Execution metrics
    this.metrics = {
      totalWorkflows: 0,
      activeWorkflows: 0,
      completedWorkflows: 0,
      failedWorkflows: 0,
      cancelledWorkflows: 0,
      totalSteps: 0,
      avgExecutionTime: 0,
      totalExecutionTime: 0
    };
    
    // Start background tasks
    this.startHeartbeat();
    this.startCleanup();
    
    // Listen to discovery events
    this.setupDiscoveryListeners();
  }

  /**
   * Setup discovery service listeners
   */
  setupDiscoveryListeners() {
    this.discoveryService.on('mcps_added', (mcpNames) => {
      for (const name of mcpNames) {
        this.addMcpClient(name);
      }
    });
    
    this.discoveryService.on('mcps_removed', (mcpNames) => {
      for (const name of mcpNames) {
        this.removeMcpClient(name);
      }
    });
    
    this.discoveryService.on('mcps_updated', (mcpNames) => {
      for (const name of mcpNames) {
        this.updateMcpClient(name);
      }
    });
  }

  /**
   * Add MCP client
   */
  async addMcpClient(mcpName) {
    try {
      const mcpConfig = this.discoveryService.getMcp(mcpName);
      if (!mcpConfig) return;
      
      const { MCPClient } = require('./mcp-client');
      const client = new MCPClient(mcpConfig, { logger: this.logger });
      
      this.mcpClients.set(mcpName, client);
      this.emit('mcp_client_added', mcpName, client);
      this.logger.info(`Added MCP client: ${mcpName}`);
      
    } catch (error) {
      this.logger.error(`Failed to add MCP client ${mcpName}:`, error);
    }
  }

  /**
   * Remove MCP client
   */
  async removeMcpClient(mcpName) {
    const client = this.mcpClients.get(mcpName);
    if (client) {
      await client.shutdown();
      this.mcpClients.delete(mcpName);
      this.emit('mcp_client_removed', mcpName);
      this.logger.info(`Removed MCP client: ${mcpName}`);
    }
  }

  /**
   * Update MCP client
   */
  async updateMcpClient(mcpName) {
    await this.removeMcpClient(mcpName);
    await this.addMcpClient(mcpName);
  }

  /**
   * Register workflow definition
   */
  registerWorkflow(definition) {
    const workflow = new Workflow(definition);
    this.workflows.set(workflow.name, workflow);
    this.emit('workflow_registered', workflow);
    this.logger.info(`Registered workflow: ${workflow.name} v${workflow.version}`);
    return workflow;
  }

  /**
   * Load workflow from YAML file
   */
  async loadWorkflowFromFile(filePath) {
    const fs = require('fs').promises;
    const content = await fs.readFile(filePath, 'utf8');
    
    let definition;
    if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
      definition = yaml.load(content);
    } else {
      definition = JSON.parse(content);
    }
    
    return this.registerWorkflow(definition);
  }

  /**
   * Execute workflow
   */
  async executeWorkflow(workflowName, input = {}, options = {}) {
    const workflow = this.workflows.get(workflowName);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowName}`);
    }
    
    // Check concurrent execution limit
    if (this.activeExecutions.size >= this.options.maxConcurrentWorkflows) {
      throw new Error('Maximum concurrent workflows reached');
    }
    
    const context = new WorkflowContext(workflow, input);
    context.metadata = { ...options.metadata };
    
    this.activeExecutions.set(context.workflowId, context);
    this.metrics.totalWorkflows++;
    this.metrics.activeWorkflows++;
    
    this.emit('workflow_started', context);
    this.logger.info(`Started workflow execution: ${workflowName} (${context.workflowId})`);
    
    try {
      const result = await this.executeWorkflowContext(context);
      return result;
    } catch (error) {
      this.logger.error(`Workflow execution failed: ${workflowName} (${context.workflowId})`, error);
      throw error;
    }
  }

  /**
   * Execute workflow context
   */
  async executeWorkflowContext(context) {
    context.state = WorkflowState.RUNNING;
    context.startTime = new Date();
    
    const timeout = setTimeout(() => {
      this.cancelWorkflow(context.workflowId, 'timeout');
    }, context.workflow.timeout);
    
    try {
      await this.runWorkflowSteps(context);
      
      // Check if all critical steps completed
      const allCriticalCompleted = Object.values(context.steps).every(step => 
        !step.critical || step.state === StepState.COMPLETED
      );
      
      if (allCriticalCompleted) {
        context.state = WorkflowState.COMPLETED;
        context.result = this.collectWorkflowResult(context);
        this.metrics.completedWorkflows++;
      } else {
        throw new Error('Not all critical steps completed successfully');
      }
      
    } catch (error) {
      context.error = error;
      context.state = WorkflowState.FAILED;
      this.metrics.failedWorkflows++;
      
      // Attempt compensation
      await this.compensateWorkflow(context);
      
      throw error;
    } finally {
      clearTimeout(timeout);
      context.endTime = new Date();
      
      // Move to history
      this.activeExecutions.delete(context.workflowId);
      this.executionHistory.set(context.workflowId, context);
      this.metrics.activeWorkflows--;
      
      // Update metrics
      const executionTime = context.endTime - context.startTime;
      this.metrics.totalExecutionTime += executionTime;
      this.metrics.avgExecutionTime = this.metrics.totalExecutionTime / this.metrics.totalWorkflows;
      
      this.emit('workflow_completed', context);
      this.logger.info(`Workflow execution completed: ${context.workflow.name} (${context.workflowId}) - ${context.state}`);
    }
    
    return context.result;
  }

  /**
   * Run workflow steps with proper dependency handling
   */
  async runWorkflowSteps(context) {
    const maxConcurrent = this.options.maxConcurrentSteps;
    const runningSteps = new Set();
    let allStepsCompleted = false;
    
    while (!allStepsCompleted && context.state === WorkflowState.RUNNING) {
      // Get steps that can be executed
      const executableSteps = context.workflow.getExecutableSteps(context)
        .filter(step => !runningSteps.has(step.name));
      
      // Start new steps (up to concurrency limit)
      const slotsAvailable = maxConcurrent - runningSteps.size;
      const stepsToStart = executableSteps.slice(0, slotsAvailable);
      
      for (const step of stepsToStart) {
        runningSteps.add(step.name);
        this.executeStep(context, step).then(() => {
          runningSteps.delete(step.name);
        }).catch(() => {
          runningSteps.delete(step.name);
        });
      }
      
      // Check if all steps are done
      const remainingSteps = Object.values(context.steps).filter(step => 
        step.state === StepState.PENDING || step.state === StepState.RUNNING
      );
      
      if (remainingSteps.length === 0) {
        allStepsCompleted = true;
      } else if (runningSteps.size === 0 && executableSteps.length === 0) {
        // Deadlock - no steps running and none can be started
        const blockedSteps = remainingSteps.map(s => s.name).join(', ');
        throw new Error(`Workflow deadlock - blocked steps: ${blockedSteps}`);
      } else {
        // Wait a bit before checking again
        await this.sleep(100);
      }
    }
    
    // Wait for any remaining running steps
    while (runningSteps.size > 0) {
      await this.sleep(100);
    }
  }

  /**
   * Execute a single workflow step
   */
  async executeStep(context, step) {
    const stepContext = context.steps[step.name];
    stepContext.state = StepState.RUNNING;
    stepContext.startTime = new Date();
    stepContext.attempt++;
    
    this.emit('step_started', context, step);
    this.logger.debug(`Started step: ${step.name} (attempt ${stepContext.attempt})`);
    
    try {
      // Get MCP client
      const mcpClient = this.mcpClients.get(step.mcp);
      if (!mcpClient) {
        throw new Error(`MCP not available: ${step.mcp}`);
      }
      
      if (!mcpClient.isHealthy()) {
        throw new Error(`MCP not healthy: ${step.mcp}`);
      }
      
      // Interpolate parameters
      const params = step.interpolateParams(context);
      
      // Execute with timeout
      const result = await Promise.race([
        mcpClient.callTool(step.action, params),
        this.timeoutPromise(step.timeout, `Step ${step.name} timeout`)
      ]);
      
      stepContext.result = result;
      stepContext.state = StepState.COMPLETED;
      stepContext.endTime = new Date();
      
      // Store result in context for other steps
      context.setStepResult(step.name, result);
      
      this.metrics.totalSteps++;
      this.emit('step_completed', context, step, result);
      this.logger.debug(`Completed step: ${step.name}`);
      
    } catch (error) {
      stepContext.error = error;
      stepContext.endTime = new Date();
      
      this.logger.warn(`Step failed: ${step.name} - ${error.message}`);
      
      // Retry if configured
      if (stepContext.attempt <= step.retries) {
        this.logger.info(`Retrying step: ${step.name} (attempt ${stepContext.attempt + 1})`);
        stepContext.state = StepState.PENDING;
        return this.executeStep(context, step);
      }
      
      // Mark as failed or skipped based on criticality
      if (step.critical) {
        stepContext.state = StepState.FAILED;
        this.emit('step_failed', context, step, error);
        throw error;
      } else {
        stepContext.state = StepState.SKIPPED;
        this.emit('step_skipped', context, step, error);
        this.logger.info(`Skipped non-critical step: ${step.name}`);
      }
    }
  }

  /**
   * Compensate workflow using saga pattern
   */
  async compensateWorkflow(context) {
    if (context.state === WorkflowState.COMPENSATING) {
      return; // Already compensating
    }
    
    context.state = WorkflowState.COMPENSATING;
    this.emit('workflow_compensation_started', context);
    this.logger.info(`Starting compensation for workflow: ${context.workflowId}`);
    
    const compensationOrder = context.workflow.getCompensationOrder();
    
    for (const stepName of compensationOrder) {
      const step = context.steps[stepName];
      const originalStep = context.workflow.steps[stepName];
      
      if (!originalStep.compensation) continue;
      
      try {
        step.state = StepState.COMPENSATING;
        this.emit('step_compensation_started', context, originalStep);
        
        // Get MCP client
        const mcpClient = this.mcpClients.get(originalStep.compensation.mcp || originalStep.mcp);
        if (!mcpClient) {
          this.logger.warn(`MCP not available for compensation: ${originalStep.mcp}`);
          continue;
        }
        
        // Interpolate compensation parameters
        const params = this.interpolateCompensationParams(originalStep.compensation, context, step);
        
        // Execute compensation
        await mcpClient.callTool(originalStep.compensation.action, params);
        
        step.state = StepState.COMPENSATED;
        this.emit('step_compensated', context, originalStep);
        this.logger.debug(`Compensated step: ${stepName}`);
        
      } catch (error) {
        this.logger.error(`Compensation failed for step ${stepName}:`, error);
        this.emit('step_compensation_failed', context, originalStep, error);
      }
    }
    
    context.state = WorkflowState.COMPENSATED;
    this.emit('workflow_compensated', context);
    this.logger.info(`Compensation completed for workflow: ${context.workflowId}`);
  }

  /**
   * Interpolate compensation parameters
   */
  interpolateCompensationParams(compensation, context, stepContext) {
    const params = { ...compensation.params };
    
    // Add step result and error to context for compensation
    const compensationContext = {
      ...context,
      compensation: {
        originalResult: stepContext.result,
        originalError: stepContext.error
      }
    };
    
    return this.interpolateObject(params, compensationContext);
  }

  /**
   * Cancel workflow execution
   */
  async cancelWorkflow(workflowId, reason = 'cancelled') {
    const context = this.activeExecutions.get(workflowId);
    if (!context) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    
    context.state = WorkflowState.CANCELLED;
    context.error = new Error(`Workflow cancelled: ${reason}`);
    
    this.metrics.cancelledWorkflows++;
    this.emit('workflow_cancelled', context, reason);
    this.logger.info(`Cancelled workflow: ${workflowId} (${reason})`);
    
    // Compensate if needed
    await this.compensateWorkflow(context);
  }

  /**
   * Collect workflow result from step results
   */
  collectWorkflowResult(context) {
    const result = {
      workflowId: context.workflowId,
      steps: {}
    };
    
    for (const [name, step] of Object.entries(context.steps)) {
      result.steps[name] = {
        state: step.state,
        result: step.result,
        error: step.error
      };
    }
    
    return result;
  }

  /**
   * Get workflow execution status
   */
  getWorkflowStatus(workflowId) {
    const context = this.activeExecutions.get(workflowId) || 
                   this.executionHistory.get(workflowId);
    
    if (!context) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    
    return {
      workflowId: context.workflowId,
      workflowName: context.workflow.name,
      state: context.state,
      startTime: context.startTime,
      endTime: context.endTime,
      steps: Object.fromEntries(
        Object.entries(context.steps).map(([name, step]) => [
          name,
          {
            state: step.state,
            startTime: step.startTime,
            endTime: step.endTime,
            attempt: step.attempt,
            hasResult: step.result !== null,
            hasError: step.error !== null
          }
        ])
      ),
      result: context.result,
      error: context.error?.message
    };
  }

  /**
   * List all workflows
   */
  listWorkflows() {
    return Array.from(this.workflows.values()).map(workflow => ({
      name: workflow.name,
      version: workflow.version,
      description: workflow.description,
      stepCount: workflow.stepOrder.length
    }));
  }

  /**
   * List active executions
   */
  listActiveExecutions() {
    return Array.from(this.activeExecutions.values()).map(context => ({
      workflowId: context.workflowId,
      workflowName: context.workflow.name,
      state: context.state,
      startTime: context.startTime,
      completedSteps: Object.values(context.steps).filter(s => s.state === StepState.COMPLETED).length,
      totalSteps: Object.keys(context.steps).length
    }));
  }

  /**
   * Get engine metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      registeredWorkflows: this.workflows.size,
      activeMcpClients: this.mcpClients.size,
      healthyMcpClients: Array.from(this.mcpClients.values()).filter(c => c.isHealthy()).length
    };
  }

  /**
   * Utility methods
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  timeoutPromise(ms, message) {
    return new Promise((_, reject) => 
      setTimeout(() => reject(new Error(message)), ms)
    );
  }

  interpolateObject(obj, context) {
    if (typeof obj === 'string') {
      return this.interpolateString(obj, context);
    } else if (Array.isArray(obj)) {
      return obj.map(item => this.interpolateObject(item, context));
    } else if (typeof obj === 'object' && obj !== null) {
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.interpolateObject(value, context);
      }
      return result;
    }
    return obj;
  }

  interpolateString(str, context) {
    if (typeof str !== 'string') return str;
    
    return str.replace(/\$\{([^}]+)\}/g, (match, path) => {
      const value = this.getNestedValue(context, path);
      return value !== undefined ? value : match;
    }).replace(/\$([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)/g, (match, path) => {
      const value = this.getNestedValue(context, path);
      return value !== undefined ? value : match;
    });
  }

  getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : undefined;
    }, obj);
  }

  /**
   * Background tasks
   */
  startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      this.emit('heartbeat', {
        timestamp: new Date(),
        activeExecutions: this.activeExecutions.size,
        metrics: this.getMetrics()
      });
    }, this.options.heartbeatInterval);
  }

  startCleanup() {
    this.cleanupTimer = setInterval(() => {
      // Clean old execution history
      const cutoff = Date.now() - (24 * 60 * 60 * 1000); // 24 hours
      for (const [id, context] of this.executionHistory.entries()) {
        if (context.endTime && context.endTime.getTime() < cutoff) {
          this.executionHistory.delete(id);
        }
      }
    }, this.options.cleanupInterval);
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    this.logger.info('Shutting down orchestration engine...');
    
    // Clear timers
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    
    // Cancel active workflows
    const activeIds = Array.from(this.activeExecutions.keys());
    for (const id of activeIds) {
      try {
        await this.cancelWorkflow(id, 'shutdown');
      } catch (error) {
        this.logger.warn(`Error cancelling workflow ${id}:`, error);
      }
    }
    
    // Shutdown MCP clients
    for (const client of this.mcpClients.values()) {
      try {
        await client.shutdown();
      } catch (error) {
        this.logger.warn('Error shutting down MCP client:', error);
      }
    }
    
    this.emit('shutdown');
    this.logger.info('Orchestration engine shut down');
  }
}

module.exports = {
  OrchestrationEngine,
  Workflow,
  WorkflowStep,
  WorkflowContext,
  WorkflowState,
  StepState
};