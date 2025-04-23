import express from 'express';
import path from 'path';
import { TpaServer, TpaSession, ViewType } from '@augmentos/sdk';
import axios from 'axios';
import crypto from 'crypto';

// Configuration
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'com.everywoah.airquality';
const AUGMENTOS_API_KEY = process.env.AUGMENTOS_API_KEY!;
const AQI_TOKEN = process.env.AQI_TOKEN!;
const NGROK_DEBUG = process.env.NGROK_DEBUG === 'true';

// Validate critical environment variables
if (!AUGMENTOS_API_KEY || !AQI_TOKEN) {
  console.error('❌ Missing required environment variables');
  console.error(`AUGMENTOS_API_KEY: ${AUGMENTOS_API_KEY ? '***' : 'MISSING'}`);
  console.error(`AQI_TOKEN: ${AQI_TOKEN ? '***' : 'MISSING'}`);
  process.exit(1);
}

// Air Quality Index Levels
const AQI_LEVELS = [
  { max: 50, label: "Good", emoji: "😊", advice: "Perfect for outdoor activities!" },
  { max: 100, label: "Moderate", emoji: "😐", advice: "Acceptable air quality" },
  { max: 150, label: "Unhealthy for Sensitive Groups", emoji: "😷", advice: "Reduce prolonged exertion" },
  { max: 200, label: "Unhealthy", emoji: "😨", advice: "Wear a mask outdoors" },
  { max: 300, label: "Very Unhealthy", emoji: "⚠️", advice: "Limit outdoor exposure" },
  { max: Infinity, label: "Hazardous", emoji: "☢️", advice: "Stay indoors with windows closed" }
];

class AirQualityApp extends TpaServer {
  private requestCount = 0;
  private activeSessions = new Map<string, { userId: string, started: Date }>();

  constructor() {
    super({
      packageName: PACKAGE_NAME,
      apiKey: AUGMENTOS_API_KEY,
      port: PORT,
      publicDir: path.join(__dirname, '../public'),
    });
    
    this.setupRoutes();
  }
  
  private setupRoutes() {
    const expressApp = this.getExpressApp();

    // Enhanced request logging
    expressApp.use((req, res, next) => {
      const requestId = crypto.randomUUID();
      this.requestCount++;
      const startTime = Date.now();
      
      req.id = requestId;
      res.set('X-Request-ID', requestId);
      
      // Log request details
      if (NGROK_DEBUG) {
        console.log(`[${new Date().toISOString()}] REQ#${this.requestCount} ${req.method} ${req.path}`, {
          headers: req.headers,
          body: req.body,
          ip: req.ip
        });
      }

      // Response logging
      res.on('finish', () => {
        const duration = Date.now() - startTime;
        console.log(`[${new Date().toISOString()}] RES#${this.requestCount} ${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`);
      });

      next();
    });

    // CORS configuration
    expressApp.use((req, res, next) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Access-Control-Allow-Headers", "Content-Type, X-AugmentOS-Signature");
      res.header("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
      
      // Handle preflight requests
      if (req.method === 'OPTIONS') {
        return res.status(200).end();
      }
      
      next();
    });

    expressApp.use(express.json({ limit: '10kb' }));

    // Unified webhook handler with enhanced diagnostics
    const handleWebhook = async (req: express.Request, res: express.Response) => {
      const requestDetails = {
        path: req.path,
        headers: req.headers,
        body: req.body,
        receivedAt: new Date().toISOString()
      };

      console.log('📨 Webhook received:', JSON.stringify(requestDetails, null, 2));

      // Validate request format
      if (!req.body?.type) {
        const error = new Error(`Invalid webhook payload: Missing type field`);
        console.error('❌ Webhook validation failed:', error.message, requestDetails);
        return res.status(400).json({ 
          status: 'error',
          message: 'Invalid request format',
          requestId: req.id,
          requiredFields: ['type', 'sessionId', 'userId']
        });
      }

      // Handle session requests
      if (req.body.type === 'session_request') {
        try {
          console.log('🔄 Processing session request for:', req.body.sessionId);
          await this.handleAugmentOSSession(req.body);
          
          res.json({ 
            status: 'success',
            sessionId: req.body.sessionId,
            requestId: req.id,
            timestamp: new Date().toISOString(),
            activeSessions: this.activeSessions.size
          });
        } catch (error) {
          console.error('💥 Webhook processing failed:', {
            error: error.message,
            stack: error.stack,
            request: requestDetails
          });
          
          res.status(500).json({
            status: 'error',
            message: 'Internal server error',
            requestId: req.id,
            timestamp: new Date().toISOString()
          });
        }
      } else {
        console.warn('⚠️ Unsupported webhook type:', req.body.type);
        res.status(400).json({ 
          status: 'error',
          message: 'Unsupported request type',
          requestId: req.id,
          supportedTypes: ['session_request']
        });
      }
    };

    // Dual endpoints for AugmentOS compatibility
    expressApp.post('/webhook', handleWebhook);
    expressApp.post('/webbook', handleWebhook);

    // Enhanced health check
    expressApp.get('/health', (req, res) => {
      const healthStatus = {
        status: "healthy",
        service: PACKAGE_NAME,
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        system: {
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          activeSessions: this.activeSessions.size,
          totalRequests: this.requestCount
        },
        dependencies: {
          augmentos: true,
          aqiService: !!AQI_TOKEN
        }
      };
      
      res.json(healthStatus);
    });

    // Root endpoint with service information
    expressApp.get('/', (req, res) => {
      res.json({ 
        service: PACKAGE_NAME,
        status: "operational",
        version: "1.0.0",
        endpoints: {
          health: "/health",
          webhooks: ["/webhook (primary)", "/webbook (compatibility)"]
        },
        diagnostics: {
          ngrokDebug: NGROK_DEBUG,
          requestId: req.id,
          activeSessions: this.activeSessions.size
        }
      });
    });

    // Error handling middleware
    expressApp.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
      console.error('🚨 Unhandled error:', {
        error: err.message,
        stack: err.stack,
        request: {
          id: req.id,
          method: req.method,
          path: req.path,
          body: req.body
        }
      });
      
      res.status(500).json({
        status: 'error',
        message: 'Internal server error',
        requestId: req.id,
        timestamp: new Date().toISOString()
      });
    });
  }
  
  private async handleAugmentOSSession(sessionData: any) {
    if (!sessionData.sessionId || !sessionData.userId) {
      throw new Error("Missing required session fields");
    }

    console.log('🛠️ Creating session:', {
      sessionId: sessionData.sessionId,
      userId: sessionData.userId,
      timestamp: sessionData.timestamp || new Date().toISOString()
    });

    // Track active sessions
    this.activeSessions.set(sessionData.sessionId, {
      userId: sessionData.userId,
      started: new Date()
    });

    const mockSession = {
      layouts: {
        showTextWall: (text: string, options: any) => {
          console.log(`[DISPLAY] ${text}`, options);
        }
      },
      onVoiceCommand: (command: string, callback: () => void) => {
        console.log(`[VOICE] Registered command: "${command}"`);
        callback();
      },
      getUserLocation: async () => {
        console.log('[LOCATION] Fetching coordinates');
        return { 
          latitude: 51.5074, 
          longitude: -0.1278,
          accuracy: 50,
          timestamp: new Date().toISOString()
        };
      }
    };

    this.onSession(
      mockSession as unknown as TpaSession,
      sessionData.sessionId,
      sessionData.userId
    );
  }

  protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    console.log(`\n🌬️ Starting session ${sessionId} for ${userId}\n`);
    
    try {
      this.setupVoiceCommands(session);
      await this.checkAirQuality(session);
    } catch (error) {
      console.error(`Session ${sessionId} failed:`, {
        error: error.message,
        stack: error.stack,
        sessionId,
        userId
      });
      
      session.layouts.showTextWall("Session error - please try again", {
        view: ViewType.MAIN,
        durationMs: 5000
      });
      
      // Remove failed session from tracking
      this.activeSessions.delete(sessionId);
    }
  }
  
  private setupVoiceCommands(session: TpaSession) {
    const commands = [
      "air quality", 
      "what's the air like", 
      "pollution", 
      "air pollution", 
      "is the air clean", 
      "is the air dirty",
      "how clean is the air"
    ];
    
    commands.forEach(command => {
      session.onVoiceCommand(command, async () => {
        console.log(`🎤 Voice command received: "${command}"`);
        try {
          await this.checkAirQuality(session);
        } catch (error) {
          console.error('Command processing failed:', {
            command,
            error: error.message,
            stack: error.stack
          });
          
          session.layouts.showTextWall("Sorry, I couldn't check air quality", {
            view: ViewType.MAIN,
            durationMs: 3000
          });
        }
      });
    });
  }
  
  private async checkAirQuality(session: TpaSession) {
    const startTime = Date.now();
    
    try {
      session.layouts.showTextWall("Checking air quality...", {
        view: ViewType.MAIN,
        durationMs: 2000
      });

      console.log('📍 Fetching user location...');
      const location = await Promise.race([
        session.getUserLocation(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Location request timeout (5s)")), 5000)
        )
      ]);

      if (!location?.latitude || !location?.longitude) {
        throw new Error("Invalid location data received");
      }

      console.log('🌍 Location acquired:', {
        lat: location.latitude,
        lng: location.longitude,
        accuracy: location.accuracy
      });
      
      console.log('📡 Fetching AQI data...');
      const aqiData = await this.fetchAQI(location.latitude, location.longitude);
      const quality = AQI_LEVELS.find(l => aqiData.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];
      
      const message = `At ${aqiData.city.name}:\n` +
                     `Air Quality: ${quality.label} ${quality.emoji}\n` +
                     `AQI Index: ${aqiData.aqi}\n\n` +
                     `Recommendation: ${quality.advice}`;
      
      session.layouts.showTextWall(message, {
        view: ViewType.MAIN,
        durationMs: 10000
      });

      console.log(`✅ AQI Displayed (${Date.now() - startTime}ms)`, {
        aqi: aqiData.aqi,
        level: quality.label,
        city: aqiData.city.name
      });
    } catch (error) {
      console.error('❌ Air quality check failed:', {
        error: error.message,
        stack: error.stack,
        duration: Date.now() - startTime
      });
      
      session.layouts.showTextWall("Air quality data unavailable", {
        view: ViewType.MAIN,
        durationMs: 5000
      });
      throw error;
    }
  }

  private async fetchAQI(lat: number, lng: number) {
    const startTime = Date.now();
    const endpoint = `https://api.waqi.info/feed/geo:${lat};${lng}/?token=${AQI_TOKEN}`;
    
    try {
      console.log(`📡 Calling WAQI API: ${endpoint.replace(AQI_TOKEN, '***')}`);
      
      const { data } = await axios.get(endpoint, { 
        timeout: 5000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'AugmentOS-AirQuality/1.0'
        },
        validateStatus: () => true // Handle all status codes
      });
      
      console.log(`🔔 WAQI API Response (${Date.now() - startTime}ms):`, {
        status: data.status,
        dataPresent: !!data.data
      });

      if (data.status !== 'ok' || !data.data) {
        throw new Error(`API error: ${data.status || 'No data'} ${data.message || ''}`);
      }
      
      return {
        aqi: data.data.aqi,
        city: data.data.city,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('💥 WAQI API call failed:', {
        error: error.message,
        stack: error.stack,
        endpoint: endpoint.replace(AQI_TOKEN, '***'),
        duration: Date.now() - startTime
      });
      throw new Error(`Air quality service unavailable: ${error.message}`);
    }
  }

  protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
    console.log(`🔚 Session ended:`, {
      sessionId,
      userId,
      reason,
      duration: this.activeSessions.has(sessionId) 
        ? Date.now() - this.activeSessions.get(sessionId)!.started.getTime()
        : 'unknown'
    });
    
    this.activeSessions.delete(sessionId);
  }
}

// Startup
console.log('🚀 Starting Air Quality App...');
console.log('Environment Check:', {
  PORT,
  PACKAGE_NAME,
  AUGMENTOS_API_KEY: AUGMENTOS_API_KEY ? '***' : 'MISSING',
  AQI_TOKEN: AQI_TOKEN ? '***' : 'MISSING',
  NGROK_DEBUG
});

const airQualityApp = new AirQualityApp();

airQualityApp.start()
  .then(() => {
    console.log(`
✅ Air Quality App Online
─────────────────────────────
• Local: http://localhost:${PORT}
• Health: http://localhost:${PORT}/health
• Webhooks: 
  - POST /webhook
  - POST /webbook (compatibility)
• Debug Mode: ${NGROK_DEBUG ? 'ON' : 'OFF'}
─────────────────────────────
Voice commands ready:
${[
  "air quality",
  "what's the air like",
  "pollution",
  "air pollution", 
  "is the air clean",
  "is the air dirty",
  "how clean is the air"
].map(cmd => `• "${cmd}"`).join('\n')}
`);
  })
  .catch(error => {
    console.error(`
🚨 Failed to Start Server
─────────────────────────────
Error: ${error.message}

Stack Trace:
${error.stack}

Check:
1. Port ${PORT} is available (netstat -tulnp | grep ${PORT})
2. .env contains valid API keys
3. Dependencies are installed (npm install)
4. Ngrok is properly configured (ngrok http ${PORT})
─────────────────────────────
`);
    process.exit(1);
  });