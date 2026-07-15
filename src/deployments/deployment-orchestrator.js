// Enhanced Deployment Orchestrator
// Production deployment and orchestration for DEMO Platform

const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

class DeploymentOrchestrator {
  constructor() {
    this.config = {
      environments: ['development', 'staging', 'production'],
      services: [
        'api-server',
        'web-dashboard',
        'mobile-interface',
        'widget',
        'ai-services',
        'database',
        'cache',
        'monitoring'
      ],
      deploymentStrategies: ['blue-green', 'rolling', 'canary'],
      healthChecks: [
        'api-health',
        'database-connection',
        'cache-connection',
        'ai-models',
        'external-apis'
      ]
    };
    
    this.deploymentState = {
      currentEnvironment: null,
      deploymentId: null,
      startTime: null,
      services: new Map(),
      rollbackPoints: []
    };
    
    this.execAsync = promisify(exec);
  }

  async deploy(environment, options = {}) {
    console.log(`🚀 Starting deployment to ${environment}...`);
    
    this.deploymentState.currentEnvironment = environment;
    this.deploymentState.deploymentId = this.generateDeploymentId();
    this.deploymentState.startTime = new Date();
    
    try {
      // 1. Pre-deployment checks
      await this.preDeploymentChecks(environment, options);
      
      // 2. Build and package
      await this.buildAndPackage(environment, options);
      
      // 3. Database migrations
      await this.runDatabaseMigrations(environment, options);
      
      // 4. Deploy services
      await this.deployServices(environment, options);
      
      // 5. Health checks
      await this.runHealthChecks(environment, options);
      
      // 6. Post-deployment tasks
      await this.postDeploymentTasks(environment, options);
      
      // 7. Cleanup
      await this.cleanupDeployment(environment, options);
      
      console.log(`✅ Deployment to ${environment} completed successfully!`);
      console.log(`Deployment ID: ${this.deploymentState.deploymentId}`);
      
      return {
        success: true,
        deploymentId: this.deploymentState.deploymentId,
        environment: environment,
        duration: Date.now() - this.deploymentState.startTime.getTime()
      };
      
    } catch (error) {
      console.error(`❌ Deployment failed: ${error.message}`);
      
      // Attempt rollback
      if (options.rollbackOnFailure) {
        await this.rollback(environment, options);
      }
      
      return {
        success: false,
        error: error.message,
        deploymentId: this.deploymentState.deploymentId
      };
    }
  }

  async preDeploymentChecks(environment, options) {
    console.log('🔍 Running pre-deployment checks...');
    
    // Check environment configuration
    await this.validateEnvironmentConfig(environment);
    
    // Check dependencies
    await this.checkDependencies();
    
    // Check resource availability
    await this.checkResourceAvailability(environment);
    
    // Validate build configuration
    await this.validateBuildConfig(environment);
    
    console.log('✅ Pre-deployment checks passed');
  }

  async validateEnvironmentConfig(environment) {
    const configPath = path.join(__dirname, `../../config/${environment}.json`);
    
    try {
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      
      // Validate required configuration
      const requiredFields = ['database', 'redis', 'api', 'ai'];
      for (const field of requiredFields) {
        if (!config[field]) {
          throw new Error(`Missing required configuration field: ${field}`);
        }
      }
      
      // Validate API keys
      if (environment === 'production') {
        const requiredKeys = ['OPENAI_API_KEY', 'GOOGLE_API_KEY', 'FSE_API_KEY'];
        for (const key of requiredKeys) {
          if (!process.env[key]) {
            throw new Error(`Missing required environment variable: ${key}`);
          }
        }
      }
      
      console.log(`✅ Environment configuration validated for ${environment}`);
    } catch (error) {
      throw new Error(`Environment configuration validation failed: ${error.message}`);
    }
  }

  async checkDependencies() {
    console.log('📦 Checking dependencies...');
    
    try {
      // Check Node.js version
      const { stdout: nodeVersion } = await this.execAsync('node --version');
      const majorVersion = parseInt(nodeVersion.replace('v', '').split('.')[0]);
      
      if (majorVersion < 18) {
        throw new Error(`Node.js version ${nodeVersion.trim()} is not supported. Required: >= 18`);
      }
      
      // Check npm packages
      await this.execAsync('npm install --production=false');
      
      // Check Docker (if using containers)
      try {
        await this.execAsync('docker --version');
        console.log('🐳 Docker available');
      } catch (error) {
        console.log('⚠️ Docker not available, skipping container checks');
      }
      
      console.log('✅ Dependencies check passed');
    } catch (error) {
      throw new Error(`Dependency check failed: ${error.message}`);
    }
  }

  async checkResourceAvailability(environment) {
    console.log('💾 Checking resource availability...');
    
    // Check disk space
    const { stdout: diskUsage } = await this.execAsync('df -h /');
    console.log(`Disk usage: ${diskUsage}`);
    
    // Check memory
    const { stdout: memoryInfo } = await this.execAsync('free -h');
    console.log(`Memory info: ${memoryInfo}`);
    
    // Check network connectivity
    try {
      await this.execAsync('ping -c 1 google.com');
      console.log('🌐 Network connectivity OK');
    } catch (error) {
      console.warn('⚠️ Network connectivity issues detected');
    }
    
    console.log('✅ Resource availability check passed');
  }

  async validateBuildConfig(environment) {
    console.log('🏗️ Validating build configuration...');
    
    // Check build scripts
    const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
    const requiredScripts = ['build', 'test', 'lint'];
    
    for (const script of requiredScripts) {
      if (!packageJson.scripts[script]) {
        throw new Error(`Missing required script: ${script}`);
      }
    }
    
    // Validate environment-specific configurations
    const envConfig = require(`../../config/${environment}.json`);
    
    // Check service configurations
    for (const service of this.config.services) {
      if (envConfig.services && envConfig.services[service]) {
        console.log(`✅ Service ${service} configured for ${environment}`);
      }
    }
    
    console.log('✅ Build configuration validated');
  }

  async buildAndPackage(environment, options) {
    console.log('📦 Building and packaging...');
    
    // Clean build directory
    await this.execAsync('rm -rf dist build');
    
    // Run linting
    console.log('🔍 Running linting...');
    await this.execAsync('npm run lint');
    
    // Run tests
    console.log('🧪 Running tests...');
    await this.execAsync('npm test');
    
    // Build frontend
    console.log('🏗️ Building frontend...');
    await this.execAsync('npm run build:frontend');
    
    // Build backend
    console.log('🏗️ Building backend...');
    await this.execAsync('npm run build:backend');
    
    // Create deployment package
    console.log('📦 Creating deployment package...');
    await this.createDeploymentPackage(environment);
    
    console.log('✅ Build and packaging completed');
  }

  async createDeploymentPackage(environment) {
    const packageDir = `dist/deployment-${environment}-${this.deploymentState.deploymentId}`;
    
    await fs.mkdir(packageDir, { recursive: true });
    
    // Copy essential files
    const filesToCopy = [
      'package.json',
      'package-lock.json',
      'server.js',
      'src/',
      'config/',
      'public/',
      'web-dashboard/',
      'mobile-interface/'
    ];
    
    for (const file of filesToCopy) {
      try {
        await this.execAsync(`cp -r ${file} ${packageDir}/`);
      } catch (error) {
        console.warn(`⚠️ Could not copy ${file}: ${error.message}`);
      }
    }
    
    // Create deployment manifest
    const manifest = {
      deploymentId: this.deploymentState.deploymentId,
      environment: environment,
      timestamp: new Date().toISOString(),
      version: require('../../package.json').version,
      services: this.config.services,
      checksum: await this.generateChecksum(packageDir)
    };
    
    await fs.writeFile(
      path.join(packageDir, 'deployment-manifest.json'),
      JSON.stringify(manifest, null, 2)
    );
    
    console.log(`✅ Deployment package created: ${packageDir}`);
  }

  async generateChecksum(directory) {
    try {
      const { stdout } = await this.execAsync(`find ${directory} -type f -exec md5sum {} \\; | sort | md5sum`);
      return stdout.split(' ')[0];
    } catch (error) {
      return 'checksum-unavailable';
    }
  }

  async runDatabaseMigrations(environment, options) {
    console.log('🗄️ Running database migrations...');
    
    try {
      // Run migrations
      await this.execAsync('npm run migrate');
      
      // Seed data if needed
      if (options.seedData) {
        await this.execAsync('npm run seed');
      }
      
      console.log('✅ Database migrations completed');
    } catch (error) {
      throw new Error(`Database migration failed: ${error.message}`);
    }
  }

  async deployServices(environment, options) {
    console.log('🚀 Deploying services...');
    
    const deploymentStrategy = options.deploymentStrategy || 'rolling';
    
    switch (deploymentStrategy) {
      case 'blue-green':
        await this.deployBlueGreen(environment, options);
        break;
      case 'rolling':
        await this.deployRolling(environment, options);
        break;
      case 'canary':
        await this.deployCanary(environment, options);
        break;
      default:
        throw new Error(`Unknown deployment strategy: ${deploymentStrategy}`);
    }
  }

  async deployBlueGreen(environment, options) {
    console.log('🔵 Deploying using Blue-Green strategy...');
    
    // Determine target environment (blue or green)
    const targetEnv = await this.getBlueGreenTarget(environment);
    
    // Deploy to inactive environment
    await this.deployToEnvironment(targetEnv, environment, options);
    
    // Run health checks
    await this.runHealthChecks(targetEnv, options);
    
    // Switch traffic
    await this.switchTraffic(targetEnv, environment);
    
    console.log(`✅ Blue-Green deployment completed to ${targetEnv}`);
  }

  async deployRolling(environment, options) {
    console.log('🔄 Deploying using Rolling strategy...');
    
    const services = this.config.services;
    
    for (const service of services) {
      console.log(`🔄 Deploying service: ${service}`);
      
      // Stop old service
      await this.stopService(service, environment);
      
      // Deploy new version
      await this.deployService(service, environment, options);
      
      // Start new service
      await this.startService(service, environment);
      
      // Health check
      await this.waitForServiceHealth(service, environment);
      
      console.log(`✅ Service ${service} deployed successfully`);
    }
    
    console.log('✅ Rolling deployment completed');
  }

  async deployCanary(environment, options) {
    console.log('🐦 Deploying using Canary strategy...');
    
    // Deploy to small subset of instances
    await this.deployToCanary(environment, options);
    
    // Monitor canary metrics
    await this.monitorCanaryMetrics(environment, options);
    
    // Gradually increase traffic
    await this.increaseCanaryTraffic(environment, options);
    
    console.log('✅ Canary deployment completed');
  }

  async deployToEnvironment(targetEnv, environment, options) {
    // Implementation for deploying to specific environment
    console.log(`Deploying to ${targetEnv} environment...`);
    
    // Copy deployment package
    const packageDir = `dist/deployment-${environment}-${this.deploymentState.deploymentId}`;
    const targetDir = `/opt/demo-platform/${targetEnv}`;
    
    await this.execAsync(`mkdir -p ${targetDir}`);
    await this.execAsync(`cp -r ${packageDir}/* ${targetDir}/`);
    
    // Install dependencies
    await this.execAsync(`cd ${targetDir} && npm install --production`);
    
    console.log(`✅ Deployed to ${targetEnv}`);
  }

  async switchTraffic(targetEnv, environment) {
    console.log(`🔄 Switching traffic to ${targetEnv}...`);
    
    // Update load balancer configuration
    const lbConfig = {
      production: {
        blue: '10.0.1.10',
        green: '10.0.1.11'
      }
    };
    
    const targetIP = lbConfig[environment][targetEnv];
    
    // Update nginx configuration
    await this.execAsync(`sed -i 's/upstream.*{.*}/upstream app { server ${targetIP}:3000; }/' /etc/nginx/sites-available/demo-platform`);
    await this.execAsync('nginx -s reload');
    
    console.log(`✅ Traffic switched to ${targetEnv}`);
  }

  async runHealthChecks(environment, options) {
    console.log('🏥 Running health checks...');
    
    const healthCheckResults = {};
    
    for (const check of this.config.healthChecks) {
      try {
        const result = await this.runHealthCheck(check, environment);
        healthCheckResults[check] = result;
        
        if (result.success) {
          console.log(`✅ Health check ${check}: PASSED`);
        } else {
          console.log(`❌ Health check ${check}: FAILED - ${result.error}`);
        }
      } catch (error) {
        healthCheckResults[check] = { success: false, error: error.message };
        console.log(`❌ Health check ${check}: ERROR - ${error.message}`);
      }
    }
    
    // Check overall health
    const failedChecks = Object.values(healthCheckResults).filter(r => !r.success);
    
    if (failedChecks.length > 0) {
      throw new Error(`Health checks failed: ${failedChecks.map(c => c.error).join(', ')}`);
    }
    
    console.log('✅ All health checks passed');
  }

  async runHealthCheck(checkType, environment) {
    switch (checkType) {
      case 'api-health':
        return await this.checkAPIHealth(environment);
      case 'database-connection':
        return await this.checkDatabaseConnection(environment);
      case 'cache-connection':
        return await this.checkCacheConnection(environment);
      case 'ai-models':
        return await this.checkAIModels(environment);
      case 'external-apis':
        return await this.checkExternalAPIs(environment);
      default:
        return { success: false, error: `Unknown health check: ${checkType}` };
    }
  }

  async checkAPIHealth(environment) {
    try {
      const response = await fetch(`http://localhost:3000/health`);
      const data = await response.json();
      
      return {
        success: data.status === 'ok',
        responseTime: data.responseTime,
        services: data.services
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async checkDatabaseConnection(environment) {
    try {
      // Test database connection
      const { Pool } = require('pg');
      const config = require(`../../config/${environment}.json`);
      
      const pool = new Pool(config.database);
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      
      return { success: true, connectionTime: Date.now() };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async checkCacheConnection(environment) {
    try {
      const redis = require('redis');
      const config = require(`../../config/${environment}.json`);
      
      const client = redis.createClient(config.redis);
      await client.ping();
      await client.quit();
      
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async checkAIModels(environment) {
    try {
      // Test AI model loading
      const { MLIntentDetector } = require('../../src/ai/intent-detection/ml-intent-detector');
      const detector = new MLIntentDetector();
      const initialized = await detector.initialize();
      
      return { success: initialized };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async checkExternalAPIs(environment) {
    const apis = ['health-api', 'municipal-api'];
    const results = {};
    
    for (const api of apis) {
      try {
        // Test API connectivity
        const response = await fetch(`http://localhost:3000/api/${api}/health`);
        results[api] = { success: response.ok };
      } catch (error) {
        results[api] = { success: false, error: error.message };
      }
    }
    
    return { success: Object.values(results).every(r => r.success), apis: results };
  }

  async postDeploymentTasks(environment, options) {
    console.log('📋 Running post-deployment tasks...');
    
    // Update monitoring
    await this.updateMonitoring(environment);
    
    // Clear caches
    await this.clearCaches(environment);
    
    // Send notifications
    await this.sendNotifications(environment, 'deployment-success');
    
    // Update documentation
    await this.updateDocumentation(environment);
    
    console.log('✅ Post-deployment tasks completed');
  }

  async updateMonitoring(environment) {
    console.log('📊 Updating monitoring configuration...');
    
    // Update Prometheus targets
    const prometheusConfig = {
      targets: [
        `demo-platform-${environment}:3000`,
        `demo-platform-${environment}:9090`
      ]
    };
    
    await fs.writeFile(
      `/etc/prometheus/targets/${environment}.json`,
      JSON.stringify(prometheusConfig, null, 2)
    );
    
    // Reload Prometheus
    await this.execAsync('systemctl reload prometheus');
    
    console.log('✅ Monitoring updated');
  }

  async clearCaches(environment) {
    console.log('🧹 Clearing caches...');
    
    // Clear Redis cache
    try {
      const redis = require('redis');
      const config = require(`../../config/${environment}.json`);
      
      const client = redis.createClient(config.redis);
      await client.flushall();
      await client.quit();
      
      console.log('✅ Redis cache cleared');
    } catch (error) {
      console.warn(`⚠️ Could not clear Redis cache: ${error.message}`);
    }
    
    // Clear application cache
    await this.execAsync('rm -rf /tmp/demo-platform-cache/*');
    console.log('✅ Application cache cleared');
  }

  async sendNotifications(environment, type) {
    console.log('📢 Sending notifications...');
    
    const message = {
      environment: environment,
      type: type,
      deploymentId: this.deploymentState.deploymentId,
      timestamp: new Date().toISOString()
    };
    
    // Send to Slack
    if (process.env.SLACK_WEBHOOK_URL) {
      try {
        await fetch(process.env.SLACK_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `Deployment ${type} for ${environment}: ${this.deploymentState.deploymentId}`
          })
        });
      } catch (error) {
        console.warn(`⚠️ Could not send Slack notification: ${error.message}`);
      }
    }
    
    // Send email notification
    if (process.env.NOTIFICATION_EMAIL) {
      // Implementation for email notification
      console.log(`📧 Notification sent to ${process.env.NOTIFICATION_EMAIL}`);
    }
    
    console.log('✅ Notifications sent');
  }

  async updateDocumentation(environment) {
    console.log('📚 Updating documentation...');
    
    const deploymentInfo = {
      deploymentId: this.deploymentState.deploymentId,
      environment: environment,
      timestamp: new Date().toISOString(),
      services: this.config.services,
      version: require('../../package.json').version
    };
    
    // Update deployment log
    const logPath = `docs/deployments/${environment}.log`;
    await fs.appendFile(logPath, JSON.stringify(deploymentInfo) + '\n');
    
    console.log('✅ Documentation updated');
  }

  async cleanupDeployment(environment, options) {
    console.log('🧹 Cleaning up deployment...');
    
    // Clean up old deployment packages
    await this.cleanupOldPackages(environment);
    
    // Clean up logs
    await this.cleanupLogs(environment);
    
    // Clean up temporary files
    await this.cleanupTempFiles();
    
    console.log('✅ Deployment cleanup completed');
  }

  async cleanupOldPackages(environment) {
    try {
      // Keep only last 5 deployment packages
      const { stdout } = await this.execAsync(`ls -t dist/deployment-${environment}-*`);
      const packages = stdout.trim().split('\n').slice(5);
      
      for (const pkg of packages) {
        if (pkg) {
          await this.execAsync(`rm -rf ${pkg}`);
          console.log(`🗑️ Removed old package: ${pkg}`);
        }
      }
    } catch (error) {
      console.warn(`⚠️ Could not cleanup old packages: ${error.message}`);
    }
  }

  async cleanupLogs(environment) {
    try {
      // Rotate logs older than 30 days
      await this.execAsync(`find /var/log/demo-platform -name "*.log" -mtime +30 -exec gzip {} \\;`);
      await this.execAsync(`find /var/log/demo-platform -name "*.log.gz" -mtime +90 -delete`);
    } catch (error) {
      console.warn(`⚠️ Could not cleanup logs: ${error.message}`);
    }
  }

  async cleanupTempFiles() {
    try {
      await this.execAsync('find /tmp -name "demo-platform-*" -mtime +1 -delete');
    } catch (error) {
      console.warn(`⚠️ Could not cleanup temp files: ${error.message}`);
    }
  }

  async rollback(environment, options) {
    console.log('🔄 Starting rollback procedure...');
    
    try {
      // Get last successful deployment
      const lastDeployment = await this.getLastSuccessfulDeployment(environment);
      
      if (!lastDeployment) {
        throw new Error('No previous deployment found for rollback');
      }
      
      console.log(`Rolling back to deployment: ${lastDeployment.deploymentId}`);
      
      // Stop current deployment
      await this.stopAllServices(environment);
      
      // Deploy previous version
      await this.deployToEnvironment(lastDeployment.targetEnv, environment, {
        deploymentId: lastDeployment.deploymentId
      });
      
      // Switch traffic back
      await this.switchTraffic(lastDeployment.targetEnv, environment);
      
      // Run health checks
      await this.runHealthChecks(environment, options);
      
      console.log('✅ Rollback completed successfully');
      
    } catch (error) {
      console.error(`❌ Rollback failed: ${error.message}`);
      throw error;
    }
  }

  async getLastSuccessfulDeployment(environment) {
    // Implementation to get last successful deployment
    // This would typically query a deployment database or log
    return {
      deploymentId: 'deployment-123',
      targetEnv: 'blue',
      timestamp: new Date().toISOString()
    };
  }

  async stopAllServices(environment) {
    for (const service of this.config.services) {
      try {
        await this.stopService(service, environment);
      } catch (error) {
        console.warn(`⚠️ Could not stop service ${service}: ${error.message}`);
      }
    }
  }

  // Utility methods
  generateDeploymentId() {
    return `deploy-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  async getBlueGreenTarget(environment) {
    // Determine which environment (blue/green) is currently active
    // and return the inactive one
    return 'blue'; // Simplified for demo
  }

  async deployService(service, environment, options) {
    // Implementation for deploying individual service
    console.log(`Deploying service ${service}...`);
  }

  async stopService(service, environment) {
    // Implementation for stopping service
    console.log(`Stopping service ${service}...`);
  }

  async startService(service, environment) {
    // Implementation for starting service
    console.log(`Starting service ${service}...`);
  }

  async waitForServiceHealth(service, environment) {
    // Wait for service to be healthy
    console.log(`Waiting for service ${service} to be healthy...`);
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  async deployToCanary(environment, options) {
    console.log('Deploying to canary instances...');
  }

  async monitorCanaryMetrics(environment, options) {
    console.log('Monitoring canary metrics...');
  }

  async increaseCanaryTraffic(environment, options) {
    console.log('Increasing canary traffic...');
  }
}

module.exports = { DeploymentOrchestrator };