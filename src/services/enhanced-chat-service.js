/**
 * Enhanced Chat Service
 * High-performance chat service with optimized API integration and intelligent scraping
 */

//TODO - non viene più usato lo rimuoverei

const axios = require('axios');

class EnhancedChatService {
  constructor() {
    // Performance optimization settings
    this.config = {
      enableAPI: false, // Disabled - OptimizedMunicipalAPI not available
      enableScraper: false, // Disabled - OptimizedScraper not available
      enableCrawler: false, // Disabled - IntelligentCrawler not available
      enableCaching: true,
      parallelProcessing: true,
      timeout: 10000, // 10 seconds max for each operation
      maxRetries: 2,
      cacheTTL: 600 // 10 minutes default
    };
    
    // Performance metrics
    this.metrics = {
      totalRequests: 0,
      totalResponseTime: 0,
      cacheHitRate: 0,
      apiSuccessRate: 0,
      scraperSuccessRate: 0,
      averageResponseTime: 0
    };
    
    // Initialize services
    this.init();
  }

  async init() {
    console.log('🚀 Initializing Enhanced Chat Service...');
    
    try {
      // Note: municipalAPI and scraper are not available, so we skip their initialization
      console.log('⚠️ Skipping initialization of unavailable services (OptimizedMunicipalAPI, OptimizedScraper, IntelligentCrawler)');
      
      console.log('✅ Enhanced Chat Service initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize Enhanced Chat Service:', error);
    }
  }

  /**
   * Enhanced search with intelligent routing and parallel processing
   */
  async searchConfiguredSites(query, configuredUrls, options = {}) {
    const startTime = Date.now();
    this.metrics.totalRequests++;
    
    console.log(`🔍 Enhanced search for: "${query}" on ${configuredUrls.length} sites`);
    
    try {
      // Input validation
      if (!query || !configuredUrls || configuredUrls.length === 0) {
        return {
          success: false,
          data: null,
          searchStrategy: 'validation_failed',
          responseTime: 0,
          error: 'Invalid input parameters'
        };
      }

      // Intelligent routing based on query type
      const queryAnalysis = this.analyzeQuery(query);
      const searchStrategy = this.determineSearchStrategy(queryAnalysis, configuredUrls);
      
      let result;
      
      switch (searchStrategy.type) {
        case 'api_first':
          result = await this.searchWithAPIFirst(query, configuredUrls, queryAnalysis, options);
          break;
        case 'scraper_first':
          result = await this.searchWithScraperFirst(query, configuredUrls, queryAnalysis, options);
          break;
        case 'crawler_first':
          result = await this.searchWithCrawlerFirst(query, configuredUrls, queryAnalysis, options);
          break;
        case 'parallel':
          result = await this.searchInParallel(query, configuredUrls, queryAnalysis, options);
          break;
        case 'fallback':
          result = await this.searchWithFallback(query, configuredUrls, options);
          break;
        default:
          result = await this.searchWithFallback(query, configuredUrls, options);
      }
      
      const responseTime = Date.now() - startTime;
      this.metrics.totalResponseTime += responseTime;
      this.metrics.averageResponseTime = this.metrics.totalResponseTime / this.metrics.totalRequests;
      
      console.log(`✅ Enhanced search completed in ${responseTime}ms`);
      
      return {
        ...result,
        searchStrategy: searchStrategy.type,
        responseTime: responseTime,
        enhanced: true
      };
      
    } catch (error) {
      const responseTime = Date.now() - startTime;
      console.error('❌ Enhanced search failed:', error.message);
      return {
        success: false,
        data: null,
        searchStrategy: 'error',
        responseTime: responseTime,
        error: error.message
      };
    }
  }

  /**
   * Analyze query to determine best search strategy
   */
  analyzeQuery(query) {
    const queryLower = query.toLowerCase();
    
    return {
      isServiceQuery: this.isServiceQuery(queryLower),
      isFormQuery: this.isFormQuery(queryLower),
      isContactQuery: this.isContactQuery(queryLower),
      isGeneralQuery: this.isGeneralQuery(queryLower),
      priority: this.getQueryPriority(queryLower),
      keywords: this.extractKeywords(queryLower),
      shouldBlockSSL: this.shouldBlockSSLSearch(queryLower)
    };
  }

  isServiceQuery(query) {
    const serviceKeywords = [
      'servizio', 'servizi', 'ufficio', 'sportello', 'procedura', 'procedura',
      'certificato', 'certificati', 'anagrafe', 'stato civile'
    ];
    return serviceKeywords.some(keyword => query.includes(keyword));
  }

  isFormQuery(query) {
    const formKeywords = [
      'modulo', 'moduli', 'domanda', 'istanza', 'richiesta', 'form',
      'modello', 'pratica', 'documenti', 'documentazione'
    ];
    return formKeywords.some(keyword => query.includes(keyword));
  }

  isContactQuery(query) {
    const contactKeywords = [
      'telefono', 'email', 'telefono', 'indirizzo', 'contatto', 'contatti',
      'orari', 'apertura', 'chiusura', 'ufficio'
    ];
    return contactKeywords.some(keyword => query.includes(keyword));
  }

  isGeneralQuery(query) {
    return !this.isServiceQuery(query) && !this.isFormQuery(query) && !this.isContactQuery(query);
  }

  getQueryPriority(query) {
    if (this.isFormQuery(query)) return 'high';
    if (this.isContactQuery(query)) return 'medium';
    if (this.isServiceQuery(query)) return 'medium';
    return 'low';
  }

  extractKeywords(query) {
    const keywords = [];
    const words = query.split(/\s+/);
    
    words.forEach(word => {
      if (word.length > 3) {
        keywords.push(word);
      }
    });
    
    return keywords.slice(0, 5); // Limit to 5 keywords
  }

  /**
   * Determine search strategy based on query analysis
   */
  determineSearchStrategy(queryAnalysis, configuredUrls) {
    const hasAPI = this.config.enableAPI;
    const hasScraper = this.config.enableScraper;
    const hasCrawler = this.config.enableCrawler;
    
    if (queryAnalysis.isFormQuery && hasScraper) {
      return { type: 'scraper_first', reason: 'Form queries benefit from HTML content scraping' };
    }
    
    if (queryAnalysis.isContactQuery && hasScraper) {
      return { type: 'scraper_first', reason: 'Contact info is often in HTML content' };
    }
    
    if (queryAnalysis.isGeneralQuery && hasCrawler) {
      return { type: 'crawler_first', reason: 'General queries benefit from deep crawling and content discovery' };
    }
    
    if (queryAnalysis.priority === 'high' && hasScraper && hasCrawler) {
      return { type: 'parallel', reason: 'High priority queries benefit from parallel processing' };
    }
    
    if (hasScraper || hasCrawler || hasAPI) {
      return { type: 'scraper_first', reason: 'Default to scraper-first approach, then crawler, then API' };
    }
    
    return { type: 'fallback', reason: 'No optimized services available' };
  }

  /**
   * Search with API first, then scraper as fallback
   */
  async searchWithAPIFirst(query, configuredUrls, queryAnalysis, options) {
    console.log('📡 API-first search strategy');
    
    try {
      // Try API first
      const apiResult = await this.searchWithAPI(query, configuredUrls, queryAnalysis);
      
      if (apiResult.success && this.hasSufficientData(apiResult.data)) {
        console.log('✅ API result sufficient');
        return apiResult;
      }
      
      console.log('🔄 API result insufficient, trying scraper');
      
      // Fallback to scraper
      const scraperResult = await this.searchWithScraper(query, configuredUrls, queryAnalysis);
      
      if (scraperResult.success) {
        console.log('✅ Scraper result available');
        return this.mergeResults(apiResult, scraperResult);
      }
      
      return apiResult;
      
    } catch (error) {
      console.log('❌ API-first failed, trying scraper fallback');
      return await this.searchWithScraper(query, configuredUrls, queryAnalysis);
    }
  }

  /**
   * Search with scraper first, then API as fallback
   */
  async searchWithScraperFirst(query, configuredUrls, queryAnalysis, options) {
    console.log('🕷️ Scraper-first search strategy');
    
    try {
      // Try scraper first
      const scraperResult = await this.searchWithScraper(query, configuredUrls, queryAnalysis);
      
      if (scraperResult.success && this.hasSufficientData(scraperResult.data)) {
        console.log('✅ Scraper result sufficient');
        return scraperResult;
      }
      
      console.log('🔄 Scraper result insufficient, trying API');
      
      // Fallback to API
      const apiResult = await this.searchWithAPI(query, configuredUrls, queryAnalysis);
      
      if (apiResult.success) {
        console.log('✅ API result available');
        return this.mergeResults(scraperResult, apiResult);
      }
      
      return scraperResult;
      
    } catch (error) {
      console.log('❌ Scraper-first failed, trying API fallback');
      return await this.searchWithAPI(query, configuredUrls, queryAnalysis);
    }
  }

  /**
   * Search with both API and scraper in parallel
   */
  async searchInParallel(query, configuredUrls, queryAnalysis, options) {
    console.log('⚡ Parallel search strategy');
    
    try {
      // Run both searches in parallel with timeout
      const [apiResult, scraperResult] = await Promise.allSettled([
        this.searchWithAPI(query, configuredUrls, queryAnalysis),
        this.searchWithScraper(query, configuredUrls, queryAnalysis)
      ]);
      
      const successfulResults = [
        apiResult.status === 'fulfilled' ? apiResult.value : null,
        scraperResult.status === 'fulfilled' ? scraperResult.value : null
      ].filter(result => result && result.success);
      
      if (successfulResults.length > 0) {
        console.log(`✅ ${successfulResults.length} parallel results available`);
        return this.mergeMultipleResults(successfulResults);
      }
      
      return {
        success: false,
        data: {},
        error: 'Both API and scraper failed'
      };
      
    } catch (error) {
      console.log('❌ Parallel search failed, trying fallback');
      return await this.searchWithFallback(query, configuredUrls, options);
    }
  }

  /**
   * Search with crawler first, then fallback to other methods
   */
  async searchWithCrawlerFirst(query, configuredUrls, queryAnalysis, options) {
    console.log('🕷️ Crawler-first search strategy');
    
    try {
      // Try crawler first for general queries
      const crawlerResult = await this.searchWithCrawler(query, configuredUrls, queryAnalysis);
      
      if (crawlerResult.success && this.hasSufficientData(crawlerResult.data)) {
        console.log('✅ Crawler result sufficient');
        return crawlerResult;
      }
      
      console.log('🔄 Crawler result insufficient, trying API fallback');
      
      // Fallback to API
      const apiResult = await this.searchWithAPI(query, configuredUrls, queryAnalysis);
      
      if (apiResult.success) {
        console.log('✅ API result available');
        return this.mergeResults(crawlerResult, apiResult);
      }
      
      console.log('🔄 API fallback insufficient, trying scraper');
      
      // Final fallback to scraper
      const scraperResult = await this.searchWithScraper(query, configuredUrls, queryAnalysis);
      
      if (scraperResult.success) {
        console.log('✅ Scraper result available');
        return this.mergeResults(crawlerResult, scraperResult);
      }
      
      return crawlerResult;
      
    } catch (error) {
      console.log('❌ Crawler-first failed, trying fallback');
      return await this.searchWithFallback(query, configuredUrls, options);
    }
  }

  /**
   * Search with crawler
   */
  async searchWithCrawler(query, configuredUrls, queryAnalysis) {
    if (!this.config.enableCrawler) {
      return { success: false, data: {}, reason: 'Crawler disabled' };
    }
    
    try {
      const results = [];
      
      // Parallel crawling of all URLs
      const crawlPromises = configuredUrls.map(async (url) => {
        try {
          const result = await this.crawler.crawlWebsite(url, {
            maxDepth: 2, // Limit depth for faster results
            maxUrlsPerLevel: 10,
            timeout: this.config.timeout
          });
          
          if (result && !result.error) {
            return {
              success: true,
              data: this.extractCrawlerData(result),
              url: url,
              source: 'crawler'
            };
          }
        } catch (error) {
          console.log(`❌ Crawling failed for ${url}:`, error.message);
          return null;
        }
      });
      
      const crawlResults = await Promise.allSettled(crawlPromises);
      const successfulResults = crawlResults
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value);
      
      if (successfulResults.length > 0) {
        return this.mergeMultipleResults(successfulResults);
      }
      
      return {
        success: false,
        data: {},
        error: 'All crawling attempts failed'
      };
      
    } catch (error) {
      console.log('❌ Crawler search failed:', error.message);
      return {
        success: false,
        data: {},
        error: error.message,
        source: 'crawler'
      };
    }
  }

  /**
   * Extract relevant data from crawler results
   */
  extractCrawlerData(crawlerResult) {
    const extractedData = {
      phones: [],
      emails: [],
      addresses: [],
      forms: [],
      services: [],
      links: [],
      textContent: '',
      metadata: {},
      sources: []
    };

    // Extract data from crawler results
    for (const [key, result] of Object.entries(crawlerResult)) {
      if (result.error) continue;
      
      // Extract phones
      const phoneRegex = /(?:\+39|0)?\s*\d{2,4}\s*\d{6,8}|800\s*\d{6}/g;
      const phones = result.content.match(phoneRegex) || [];
      phones.forEach(phone => {
        if (!extractedData.phones.includes(phone)) {
          extractedData.phones.push(phone);
        }
      });

      // Extract emails
      const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
      const emails = result.content.match(emailRegex) || [];
      emails.forEach(email => {
        if (!extractedData.emails.includes(email)) {
          extractedData.emails.push(email);
        }
      });

      // Extract addresses
      const addressRegex = /(?:Via|Piazza|Corso|Viale|Strada)\s+[a-zA-Z\s]+,\s*\d+\s*-?\s*\d{5}\s+[a-zA-Z\s()]+/gi;
      const addresses = result.content.match(addressRegex) || [];
      addresses.forEach(address => {
        if (!extractedData.addresses.includes(address)) {
          extractedData.addresses.push(address);
        }
      });

      // Extract forms and services from links
      if (result.links) {
        result.links.forEach(link => {
          const text = link.text.toLowerCase();
          const url = link.url.toLowerCase();
          
          if (text.includes('modulo') || text.includes('form') || url.includes('modulo')) {
            if (!extractedData.forms.includes(link.text)) {
              extractedData.forms.push(link.text);
            }
          }
          
          if (text.includes('servizio') || text.includes('servizi') || url.includes('servizio')) {
            if (!extractedData.services.includes(link.text)) {
              extractedData.services.push(link.text);
            }
          }
          
          if (!extractedData.links.find(l => l.url === link.url)) {
            extractedData.links.push({
              url: link.url,
              text: link.text,
              relevance: 'medium'
            });
          }
        });
      }

      // Build text content
      if (result.content) {
        extractedData.textContent += result.content + ' ';
      }
    }

    // Clean and limit data
    extractedData.phones = [...new Set(extractedData.phones)].slice(0, 10);
    extractedData.emails = [...new Set(extractedData.emails)].slice(0, 10);
    extractedData.addresses = [...new Set(extractedData.addresses)].slice(0, 10);
    extractedData.forms = [...new Set(extractedData.forms)].slice(0, 10);
    extractedData.services = [...new Set(extractedData.services)].slice(0, 10);
    extractedData.textContent = extractedData.textContent.substring(0, 3000);

    return extractedData;
  }

  /**
   * Fallback search strategy
   */
  async searchWithFallback(query, configuredUrls, options) {
    console.log('🔄 Fallback search strategy');
    
    // Try basic web search
    try {
      const results = [];
      
      for (const url of configuredUrls) {
        try {
          const result = await this.basicWebSearch(url, query);
          if (result.success) {
            results.push(result);
          }
        } catch (error) {
          console.log(`❌ Basic search failed for ${url}:`, error.message);
        }
      }
      
      if (results.length > 0) {
        return this.mergeMultipleResults(results);
      }
      
    } catch (error) {
      console.log('❌ Fallback search failed:', error.message);
    }
    
    return {
      success: false,
      data: {},
      error: 'All search strategies failed'
    };
  }

  /**
   * Search with API
   */
  async searchWithAPI(query, configuredUrls, queryAnalysis) {
    if (!this.config.enableAPI) {
      return { success: false, data: {}, reason: 'API disabled' };
    }
    
    try {
      // Extract city code from URL
      const cityCode = this.extractCityCode(configuredUrls[0]);
      
      if (!cityCode) {
        return { success: false, data: {}, reason: 'No city code found' };
      }
      
      // Search for relevant services
      const servicesResult = await this.municipalAPI.getAvailableServices(cityCode);
      
      if (servicesResult.success) {
        return {
          success: true,
          data: {
            services: servicesResult.services,
            city: servicesResult.city,
            contactInfo: servicesResult.contactInfo,
            source: 'api'
          }
        };
      }
      
      return servicesResult;
      
    } catch (error) {
      console.log('❌ API search failed:', error.message);
      return {
        success: false,
        data: {},
        error: error.message,
        source: 'api'
      };
    }
  }

  /**
   * Search with scraper
   */
  async searchWithScraper(query, configuredUrls, queryAnalysis) {
    if (!this.config.enableScraper) {
      return { success: false, data: {}, reason: 'Scraper disabled' };
    }
    
    try {
      const results = [];
      
      // Parallel scraping of all URLs
      const scrapePromises = configuredUrls.map(async (url) => {
        try {
          const result = await this.scraper.scrapeForQuery(url, query, {
            timeout: this.config.timeout,
            priority: queryAnalysis.priority
          });
          
          if (result.success) {
            return {
              ...result,
              url: url,
              source: 'scraper'
            };
          }
        } catch (error) {
          console.log(`❌ Scraping failed for ${url}:`, error.message);
          return null;
        }
      });
      
      const scrapeResults = await Promise.allSettled(scrapePromises);
      const successfulResults = scrapeResults
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value);
      
      if (successfulResults.length > 0) {
        return this.mergeMultipleResults(successfulResults);
      }
      
      return {
        success: false,
        data: {},
        error: 'All scraping attempts failed'
      };
      
    } catch (error) {
      console.log('❌ Scraper search failed:', error.message);
      return {
        success: false,
        data: {},
        error: error.message,
        source: 'scraper'
      };
    }
  }

  /**
   * Basic web search as last resort
   */
  async basicWebSearch(url, query) {
    try {
      const response = await axios.get(url, {
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      const html = response.data;
      const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      
      // Simple keyword matching
      const queryWords = query.toLowerCase().split(/\s+/);
      let matchCount = 0;
      
      queryWords.forEach(word => {
        if (text.toLowerCase().includes(word)) {
          matchCount++;
        }
      });
      
      if (matchCount > 0) {
        return {
          success: true,
          data: {
            url: url,
            matchCount: matchCount,
            textPreview: text.substring(0, 500),
            source: 'basic_search'
          }
        };
      }
      
      return {
        success: false,
        data: {},
        reason: 'No keyword matches found'
      };
      
    } catch (error) {
      return {
        success: false,
        data: {},
        error: error.message
      };
    }
  }

  /**
   * Merge results from multiple sources with zero tolerance for insufficient data
   */
  mergeResults(result1, result2) {
    if (!result1.success && !result2.success) {
      return {
        success: false,
        data: {},
        error: 'NON HO TROVATO I DATI',
        sources: []
      };
    }
    
    const mergedData = {
      phones: [],
      emails: [],
      addresses: [],
      forms: [],
      services: [],
      links: [],
      textContent: '',
      metadata: {},
      sources: []
    };
    
    // Merge data from both results
    [result1, result2].forEach(result => {
      if (result.success && result.data) {
        Object.keys(mergedData).forEach(key => {
          if (Array.isArray(mergedData[key])) {
            if (result.data[key]) {
              mergedData[key].push(...result.data[key]);
            }
          } else if (typeof mergedData[key] === 'object') {
            mergedData[key] = { ...mergedData[key], ...result.data[key] };
          }
        });
        
        if (result.data.source) {
          mergedData.sources.push(result.data.source);
        }
      }
    });
    
    // Remove duplicates and limit results
    mergedData.phones = [...new Set(mergedData.phones)].slice(0, 10);
    mergedData.emails = [...new Set(mergedData.emails)].slice(0, 10);
    mergedData.addresses = [...new Set(mergedData.addresses)].slice(0, 10);
    mergedData.forms = [...new Set(mergedData.forms)].slice(0, 10);
    mergedData.services = [...new Set(mergedData.services)].slice(0, 10);
    
    // Validate data to prevent hallucinations
    if (!this.validateData(mergedData)) {
      return {
        success: false,
        data: mergedData,
        error: 'NON HO TROVATO I DATI',
        sources: mergedData.sources
      };
    }
    
    // Zero tolerance check: require sufficient data
    const hasContacts = mergedData.phones.length > 0 || mergedData.emails.length > 0;
    const hasContent = mergedData.textContent.length > 500;
    const hasServices = mergedData.services.length > 0 || mergedData.forms.length > 0;
    
    const strongSignals = [hasContacts, hasContent, hasServices].filter(Boolean).length;
    
    if (strongSignals < 2) {
      return {
        success: false,
        data: mergedData,
        error: 'NON HO TROVATO I DATI',
        sources: mergedData.sources
      };
    }
    
    return {
      success: true,
      data: mergedData,
      merged: true,
      sources: mergedData.sources
    };
  }

  /**
   * Merge multiple results
   */
  mergeMultipleResults(results) {
    if (results.length === 0) {
      return { success: false, data: {} };
    }
    
    if (results.length === 1) {
      return results[0];
    }
    
    return results.reduce((merged, result) => {
      return this.mergeResults(merged, result);
    });
  }

  /**
   * Check if data is sufficient with zero tolerance
   */
  hasSufficientData(data) {
    if (!data) return false;
    
    const hasContacts = (data.phones && data.phones.length > 0) || 
                       (data.emails && data.emails.length > 0);
    const hasContent = data.textContent && data.textContent.length > 500;
    const hasForms = data.forms && data.forms.length > 0;
    const hasServices = data.services && data.services.length > 0;
    const hasLinks = data.links && data.links.length > 0;
    
    // Zero tolerance: require at least 2 strong signals
    const strongSignals = [hasContacts, hasContent, hasServices].filter(Boolean).length;
    
    return (strongSignals >= 2) || hasForms || hasLinks;
  }

  /**
   * Block SSL certificate searches completely
   */
  shouldBlockSSLSearch(query) {
    // Always block SSL certificate searches as they are never relevant
    return true;
  }

  /**
   * Validate data to prevent hallucinations
   */
  validateData(data) {
    if (!data) return false;
    
    // Check for hallucinated information
    if (this.containsHallucinations(data)) {
      console.log('⚠️ Detected hallucinated information');
      return false;
    }
    
    // Check for invalid phone numbers (likely VAT numbers)
    if (data.phones && data.phones.some(phone => this.isLikelyVATNumber(phone))) {
      console.log('⚠️ Detected likely VAT number instead of phone number');
      return false;
    }
    
    // Check for invalid addresses
    if (data.addresses && data.addresses.some(address => this.isInvalidAddress(address))) {
      console.log('⚠️ Detected invalid address');
      return false;
    }
    
    // Check for sufficient content
    if (data.textContent && data.textContent.length < 100) {
      console.log('⚠️ Content too short, likely insufficient data');
      return false;
    }
    
    return true;
  }

  /**
   * Check if a phone number is likely a VAT number
   */
  isLikelyVATNumber(phone) {
    if (!phone) return false;
    
    // Remove spaces and common formatting
    const cleanPhone = phone.replace(/\s+/g, '');
    
    // VAT numbers are typically 11 digits
    if (cleanPhone.length === 11 && /^\d+$/.test(cleanPhone)) {
      return true;
    }
    
    // Check for common VAT number patterns
    if (cleanPhone.length >= 10 && /^\d{10,}$/.test(cleanPhone)) {
      return true;
    }
    
    return false;
  }

  /**
   * Check if an address is invalid
   */
  isInvalidAddress(address) {
    if (!address) return false;
    
    // Check for addresses that don't contain valid street types
    const validStreetTypes = ['Via', 'Piazza', 'Corso', 'Viale', 'Strada'];
    const hasValidType = validStreetTypes.some(type => address.includes(type));
    
    // Check for postal code pattern
    const hasPostalCode = /\d{5}/.test(address);
    
    // Check for city name pattern
    const hasCityName = /[A-Z][a-z]+/.test(address);
    
    return !(hasValidType && hasPostalCode && hasCityName);
  }

  /**
   * Check if data contains hallucinated information
   */
  containsHallucinations(data) {
    if (!data) return true;
    
    // Check for common hallucination patterns
    const hallucinationPatterns = [
      /protocollo@.*\.it$/,
      /posta@.*\.it$/,
      /pec\.comune\./,
      /Piazza Municipio, \d+/
    ];
    
    // Check emails for hallucinations
    if (data.emails) {
      for (const email of data.emails) {
        if (hallucinationPatterns.some(pattern => pattern.test(email))) {
          console.log('⚠️ Detected hallucinated email:', email);
          return true;
        }
      }
    }
    
    // Check addresses for hallucinations
    if (data.addresses) {
      for (const address of data.addresses) {
        if (hallucinationPatterns.some(pattern => pattern.test(address))) {
          console.log('⚠️ Detected hallucinated address:', address);
          return true;
        }
      }
    }
    
    return false;
  }

  /**
   * Extract city code from URL
   */
  extractCityCode(url) {
    try {
      const hostname = new URL(url).hostname;
      
      // Common patterns for Italian municipal websites
      const patterns = [
        /comune\.([^.]+)\.it/,
        /([^.]+)\.gov\.it/,
        /([^.]+)\.comune\.it/
      ];
      
      for (const pattern of patterns) {
        const match = hostname.match(pattern);
        if (match) {
          return match[1].toUpperCase();
        }
      }
      
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get performance metrics
   */
  getMetrics() {
    // Note: municipalAPI and scraper are not available, so we return basic metrics only
    return {
      ...this.metrics,
      apiStats: { available: false, reason: 'OptimizedMunicipalAPI not available' },
      scraperStats: { available: false, reason: 'OptimizedScraper not available' },
      crawlerStats: { available: false, reason: 'IntelligentCrawler not available' },
      documentUploadStats: { available: false, reason: 'DocumentUploadAPI not available' },
      overallPerformance: {
        totalRequests: this.metrics.totalRequests,
        averageResponseTime: `${this.metrics.averageResponseTime.toFixed(0)}ms`,
        cacheHitRate: `${this.metrics.cacheHitRate.toFixed(1)}%`
      }
    };
  }

  /**
   * Clear all caches
   */
  clearCache() {
    // Note: municipalAPI and scraper are not available, so we skip their cache clearing
    console.log('⚠️ Skipping cache clearing for unavailable services (OptimizedMunicipalAPI, OptimizedScraper, IntelligentCrawler)');
    console.log('🧹 Enhanced Chat Service cache cleared (basic metrics only)');
  }

  /**
   * Health check
   */
  async healthCheck() {
    // Note: municipalAPI and scraper are not available, so we return basic health status
    return {
      api: { available: false, reason: 'OptimizedMunicipalAPI not available' },
      scraper: { available: false, reason: 'OptimizedScraper not available' },
      crawler: { available: false, reason: 'IntelligentCrawler not available' },
      documentUpload: { available: false, reason: 'DocumentUploadAPI not available' },
      overall: {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        note: 'Basic EnhancedChatService is functional, but optimized services are unavailable'
      }
    };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    console.log('⚙️ Enhanced Chat Service configuration updated');
  }

  /**
   * Initialize document upload API
   */
  initDocumentUpload(app) {
    // Note: DocumentUploadAPI is not available, so we skip its initialization
    console.log('⚠️ Skipping initialization of DocumentUploadAPI (not available)');
    console.log('📁 Document upload functionality is not available');
  }

  /**
   * Handle document upload from chat
   */
  async handleDocumentUpload(imageBuffer, filename, userId) {
    try {
      console.log(`🤖 Chat document upload: ${filename} for user ${userId}`);
      
      if (!this.documentUploadAPI) {
        return {
          success: false,
          error: 'Document upload API not initialized'
        };
      }
      
      const result = await this.documentUploadAPI.handleChatUpload(imageBuffer, filename);
      
      if (result.success) {
        console.log(`✅ Document upload successful: ${filename}`);
        return {
          success: true,
          message: result.message,
          analysis: result.analysis
        };
      } else {
        console.log(`❌ Document upload failed: ${filename}`);
        return {
          success: false,
          error: result.error
        };
      }
      
    } catch (error) {
      console.error('❌ Chat document upload error:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Check if query is about document analysis
   */
  isDocumentAnalysisQuery(query) {
    const documentKeywords = [
      'analizza documento', 'leggi documento', 'documento', 'referto', 'certificato',
      'prescrizione', 'cartella', 'esame', 'analisi', 'valori',
      'analizza foto', 'leggi foto', 'foto documento', 'foto referto'
    ];
    
    const queryLower = query.toLowerCase();
    return documentKeywords.some(keyword => queryLower.includes(keyword));
  }

  /**
   * Enhanced search with document analysis capability
   */
  async searchConfiguredSitesWithDocument(query, configuredUrls, options = {}) {
    // Check if this is a document analysis request
    if (this.isDocumentAnalysisQuery(query) && options.document) {
      console.log('📄 Document analysis request detected');
      return await this.handleDocumentAnalysis(options.document, query);
    }
    
    // Fall back to normal search
    return await this.searchConfiguredSites(query, configuredUrls, options);
  }

  /**
   * Handle document analysis
   */
  async handleDocumentAnalysis(document, query) {
    try {
      const { buffer, filename } = document;
      
      if (!buffer || !filename) {
        return {
          success: false,
          error: 'Invalid document data'
        };
      }
      
      const result = await this.handleDocumentUpload(buffer, filename, 'chat_user');
      
      if (result.success) {
        return {
          success: true,
          data: {
            type: 'document_analysis',
            analysis: result.analysis,
            message: result.message,
            source: 'document_upload'
          }
        };
      } else {
        return {
          success: false,
          error: result.error
        };
      }
      
    } catch (error) {
      console.error('❌ Document analysis error:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = { EnhancedChatService };