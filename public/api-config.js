/**
 * API Configuration Helper
 * Provides the correct base path for API calls based on deployment environment
 */

// Determine base path from current URL
function getApiBasePath() {
  if (typeof window === 'undefined') {
    // Node.js environment (not used in client code)
    return process.env.API_BASE_PATH || '/api';
  }

  // Browser environment
  const pathname = window.location.pathname;
  
  // Check if app is under /demo/ path
  if (pathname.startsWith('/demo/')) {
    return '/demo/api';
  }
  
  // Default to /api
  return '/api';
}

// Create global API utility
window.ApiConfig = {
  basePath: getApiBasePath(),
  
  /**
   * Build complete API endpoint URL
   * @param {string} endpoint - API endpoint (e.g., '/login', '/me', '/chat/message')
   * @returns {string} Complete API URL
   */
  getEndpoint(endpoint) {
    if (!endpoint.startsWith('/')) {
      endpoint = '/' + endpoint;
    }
    return this.basePath + endpoint;
  },
  
  /**
   * Convenience method for common endpoints
   */
  endpoints: {
    login: '/login',
    logout: '/logout',
    me: '/me',
    validateUrl: '/validate-url',
    demos: '/demos',
    siteAnalysis: '/site-analysis',
    chatMessage: '/chat/message',
    chatClear: '/chat/clear',
    chatTts: '/chat/tts',
    liveavatarSession: '/liveavatar/session',
    liveAvatarWebhook: '/liveavatar/webhook',
    twilioWebhook: '/twilio/webhook',
    monitoringStatus: '/monitoring/status'
  },
  
  /**
   * Get full endpoint URL
   */
  get(endpointKey) {
    const endpoint = this.endpoints[endpointKey];
    if (!endpoint) {
      throw new Error(`Unknown endpoint: ${endpointKey}`);
    }
    return this.getEndpoint(endpoint);
  }
};

// Log for debugging
console.log(`✅ API Config initialized: ${window.ApiConfig.basePath}`);
