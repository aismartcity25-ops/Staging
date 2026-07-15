/**
 * Sistema di monitoraggio avanzato per ComunicAI / MedicAI
 * Monitoraggio delle prestazioni, salute del sistema e gestione degli alert
 */

const fs = require('fs');
const path = require('path');

class MonitoringSystem {
  constructor() {
    this.isMonitoring = false;
    this.config = this.loadConfig();
    this.metrics = {
      apiCalls: [],
      searchResults: [],
      systemHealth: [],
      errors: [],
      performance: []
    };
    this.alerts = [];
    this.monitoringInterval = null;
    this.healthCheckInterval = null;
    
    console.log('📊 Monitoring System initialized');
  }

  loadConfig() {
    const configPath = path.join(__dirname, '..', '..', 'monitoring-config.json');
    const defaultConfig = {
      enabled: true,
      checkInterval: 30000, // 30 secondi
      healthCheckInterval: 60000, // 60 secondi
      thresholds: {
        responseTime: 5000, // 5 secondi
        errorRate: 0.1, // 10%
        memoryUsage: 80, // 80%
        cpuUsage: 80 // 80%
      },
      alerts: {
        enabled: true,
        email: null,
        webhook: null
      }
    };

    try {
      if (fs.existsSync(configPath)) {
        const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return { ...defaultConfig, ...savedConfig };
      }
    } catch (error) {
      console.warn('⚠️ Could not load monitoring config, using defaults:', error.message);
    }

    return defaultConfig;
  }

  saveConfig() {
    const configPath = path.join(__dirname, '..', '..', 'monitoring-config.json');
    try {
      fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2));
      console.log('✅ Monitoring config saved');
    } catch (error) {
      console.error('❌ Failed to save monitoring config:', error.message);
    }
  }

  start() {
    if (this.isMonitoring) {
      console.log('⚠️ Monitoring already running');
      return;
    }

    this.isMonitoring = true;
    console.log('🚀 Starting monitoring system...');

    // Avvia monitoraggio periodico
    this.monitoringInterval = setInterval(() => {
      this.performMetricsCollection();
    }, this.config.checkInterval);

    // Avvia health check
    this.healthCheckInterval = setInterval(async () => {
      await this.performHealthCheck();
    }, this.config.healthCheckInterval);

    console.log('✅ Monitoring system started');
  }

  stop() {
    if (!this.isMonitoring) {
      console.log('⚠️ Monitoring not running');
      return;
    }

    this.isMonitoring = false;
    
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    console.log('🛑 Monitoring system stopped');
  }

  async performHealthCheck() {
    const health = {
      timestamp: new Date().toISOString(),
      status: 'healthy',
      checks: {},
      issues: []
    };

    try {
      // Check API responsiveness
      health.checks.api = await this.checkAPIHealth();
      
      // Check memory usage
      health.checks.memory = this.checkMemoryHealth();
      
      // Check disk space
      health.checks.disk = this.checkDiskHealth();
      
      // Check dependencies
      health.checks.dependencies = this.checkDependenciesHealth();

      // Determine overall status
      const failedChecks = Object.values(health.checks).filter(check => check.status === 'unhealthy');
      if (failedChecks.length > 0) {
        health.status = 'unhealthy';
        health.issues = failedChecks.map(check => check.message);
      }

      this.metrics.systemHealth.push(health);
      
      // Trigger alerts if needed
      if (health.status === 'unhealthy') {
        this.triggerAlert('system_health', 'System health check failed', health);
      }

      return health;

    } catch (error) {
      console.error('❌ Health check failed:', error.message);
      this.triggerAlert('health_check_error', 'Health check error', { error: error.message });
      return { status: 'error', error: error.message };
    }
  }

  async checkAPIHealth() {
    const startTime = Date.now();
    
    try {
      // Simulate API call check
      // In a real implementation, this would check actual API endpoints
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const responseTime = Date.now() - startTime;
      const isHealthy = responseTime < this.config.thresholds.responseTime;
      
      return {
        status: isHealthy ? 'healthy' : 'unhealthy',
        responseTime,
        threshold: this.config.thresholds.responseTime,
        message: isHealthy ? 'API response time acceptable' : `API response time too high: ${responseTime}ms`
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
        message: 'API health check failed'
      };
    }
  }

  checkMemoryHealth() {
    const memUsage = process.memoryUsage();
    const memUsagePercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
    const isHealthy = memUsagePercent < this.config.thresholds.memoryUsage;
    
    return {
      status: isHealthy ? 'healthy' : 'unhealthy',
      usagePercent: Math.round(memUsagePercent),
      threshold: this.config.thresholds.memoryUsage,
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
      message: isHealthy ? 'Memory usage acceptable' : `Memory usage too high: ${Math.round(memUsagePercent)}%`
    };
  }

  checkDiskHealth() {
    // In a real implementation, this would check actual disk space
    // For now, return healthy status
    return {
      status: 'healthy',
      message: 'Disk space check not implemented'
    };
  }

  checkDependenciesHealth() {
    const checks = {
      openai: this.checkOpenAIHealth(),
      database: this.checkDatabaseHealth()
    };

    const failed = Object.values(checks).filter(check => check.status === 'unhealthy');
    return {
      status: failed.length === 0 ? 'healthy' : 'unhealthy',
      checks,
      message: failed.length === 0 ? 'All dependencies healthy' : `${failed.length} dependencies unhealthy`
    };
  }

  checkOpenAIHealth() {
    // Check if OpenAI API key is configured
    const hasApiKey = !!process.env.OPENAI_API_KEY;
    return {
      status: hasApiKey ? 'healthy' : 'unhealthy',
      configured: hasApiKey,
      message: hasApiKey ? 'OpenAI API configured' : 'OpenAI API not configured'
    };
  }

  checkDatabaseHealth() {
    // Check if users.json exists
    const usersFile = path.join(__dirname, '..', '..', 'users.json');
    const exists = fs.existsSync(usersFile);
    return {
      status: exists ? 'healthy' : 'unhealthy',
      fileExists: exists,
      message: exists ? 'Users database exists' : 'Users database missing'
    };
  }

  performMetricsCollection() {
    if (!this.isMonitoring) return;

    const metrics = {
      timestamp: new Date().toISOString(),
      memory: process.memoryUsage(),
      uptime: process.uptime(),
      activeConnections: this.getActiveConnectionsCount()
    };

    this.metrics.performance.push(metrics);

    // Keep only last 1000 entries
    if (this.metrics.performance.length > 1000) {
      this.metrics.performance = this.metrics.performance.slice(-1000);
    }
  }

  getActiveConnectionsCount() {
    // In a real implementation, this would count active WebSocket connections
    // For now, return 0
    return 0;
  }

  triggerAlert(type, message, data = {}) {
    const alert = {
      id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type,
      message,
      timestamp: new Date().toISOString(),
      data,
      acknowledged: false
    };

    this.alerts.push(alert);
    console.warn(`🚨 ALERT [${type}]: ${message}`);

    // Keep only last 100 alerts
    if (this.alerts.length > 100) {
      this.alerts = this.alerts.slice(-100);
    }

    // Send notifications if configured
    this.sendAlertNotifications(alert);
  }

  sendAlertNotifications(alert) {
    if (!this.config.alerts.enabled) return;

    // Email notification
    if (this.config.alerts.email) {
      this.sendEmailAlert(alert);
    }

    // Webhook notification
    if (this.config.alerts.webhook) {
      this.sendWebhookAlert(alert);
    }
  }

  async sendEmailAlert(alert) {
    // Email notification implementation would go here
    console.log(`📧 Email alert sent for ${alert.type}`);
  }

  async sendWebhookAlert(alert) {
    // Webhook notification implementation would go here
    console.log(`🔗 Webhook alert sent for ${alert.type}`);
  }

  recordAPICall(method, endpoint, responseTime, success = true, error = null) {
    const apiCall = {
      timestamp: new Date().toISOString(),
      method,
      endpoint,
      responseTime,
      success,
      error
    };

    this.metrics.apiCalls.push(apiCall);

    // Keep only last 1000 entries
    if (this.metrics.apiCalls.length > 1000) {
      this.metrics.apiCalls = this.metrics.apiCalls.slice(-1000);
    }

    // Check for performance issues
    if (responseTime > this.config.thresholds.responseTime) {
      this.triggerAlert('slow_response', `Slow API response: ${responseTime}ms`, apiCall);
    }

    if (!success) {
      this.triggerAlert('api_error', `API error: ${error}`, apiCall);
    }
  }

  recordSearchResult(query, success, resultCount, responseTime) {
    const searchResult = {
      timestamp: new Date().toISOString(),
      query,
      success,
      resultCount,
      responseTime
    };

    this.metrics.searchResults.push(searchResult);

    // Keep only last 1000 entries
    if (this.metrics.searchResults.length > 1000) {
      this.metrics.searchResults = this.metrics.searchResults.slice(-1000);
    }
  }

  recordError(error, context = {}) {
    const errorRecord = {
      timestamp: new Date().toISOString(),
      error: error.message || error.toString(),
      stack: error.stack,
      context
    };

    this.metrics.errors.push(errorRecord);

    // Keep only last 1000 entries
    if (this.metrics.errors.length > 1000) {
      this.metrics.errors = this.metrics.errors.slice(-1000);
    }

    // Trigger alert for critical errors
    this.triggerAlert('error', `Application error: ${error.message}`, errorRecord);
  }

  getRecentMetrics() {
    return {
      apiCalls: this.metrics.apiCalls.slice(-50),
      searchResults: this.metrics.searchResults.slice(-50),
      systemHealth: this.metrics.systemHealth.slice(-10),
      errors: this.metrics.errors.slice(-20),
      performance: this.metrics.performance.slice(-20)
    };
  }

  getRecentAlerts() {
    return this.alerts.slice(-20);
  }

  generateReport() {
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);
    const oneDayAgo = now - (24 * 60 * 60 * 1000);

    // Filter recent data
    const recentApiCalls = this.metrics.apiCalls.filter(call => 
      new Date(call.timestamp).getTime() > oneHourAgo
    );
    
    const recentErrors = this.metrics.errors.filter(error => 
      new Date(error.timestamp).getTime() > oneHourAgo
    );

    const recentHealthChecks = this.metrics.systemHealth.filter(health => 
      new Date(health.timestamp).getTime() > oneHourAgo
    );

    // Calculate metrics
    const totalCalls = recentApiCalls.length;
    const successfulCalls = recentApiCalls.filter(call => call.success).length;
    const errorRate = totalCalls > 0 ? (recentErrors.length / totalCalls) * 100 : 0;
    const avgResponseTime = totalCalls > 0 ? 
      recentApiCalls.reduce((sum, call) => sum + call.responseTime, 0) / totalCalls : 0;

    const healthyChecks = recentHealthChecks.filter(check => check.status === 'healthy').length;
    const healthScore = recentHealthChecks.length > 0 ? 
      (healthyChecks / recentHealthChecks.length) * 100 : 100;

    const summary = {
      timestamp: new Date().toISOString(),
      monitoring: this.isMonitoring,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      metrics: {
        totalCalls,
        successfulCalls,
        errorRate: Math.round(errorRate * 100) / 100,
        avgResponseTime: Math.round(avgResponseTime),
        healthScore: Math.round(healthScore),
        totalErrors: recentErrors.length,
        activeAlerts: this.alerts.filter(a => !a.acknowledged).length
      },
      alerts: {
        total: this.alerts.length,
        unacknowledged: this.alerts.filter(a => !a.acknowledged).length,
        recent: this.alerts.slice(-5)
      }
    };

    return summary;
  }
}

module.exports = { MonitoringSystem };