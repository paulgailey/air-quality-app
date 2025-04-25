import express from 'express';
import path from 'path';
import { TpaServer, TpaSession, ViewType, StreamType } from '@augmentos/sdk';
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

interface SessionData {
  sessionId: string;
  userId: string;
  type: string;
}

interface AQIData {
  aqi: number;
  city: {
    name: string;
    geo: [number, number];
    url: string;
  };
}

class AirQualityApp extends TpaServer {
  private requestCount = 0;
  private activeSessions = new Map<string, { userId: string; started: Date }>();
  private voiceCommands = [
    "air quality", 
    "what's the air like",
    "pollution",
    "air pollution",
    "is the air clean",
    "is the air dirty",
    "how clean is the air"
  ];

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

    // TPA Configuration Endpoint
    expressApp.get('/tpa_config.json', (req, res) => {
      res.json({
        voiceCommands: this.voiceCommands.map(phrase => ({
          phrase,
          description: "Check air quality information"
        })),
        permissions: ["location", "voice"],
        transcriptionLanguages: ["en-US"],  // Add this
        streamAccess: [StreamType.TRANSCRIPTION]  // Add this 
      });
    });

    // Enhanced request logging
    expressApp.use((req, res, next) => {
      const requestId = crypto.randomUUID();
      this.requestCount++;
      const startTime = Date.now();
      
      (req as any).id = requestId;
      res.set('X-Request-ID', requestId);
      
      if (NGROK_DEBUG) {
        console.log(`[${new Date().toISOString()}] REQ#${this.requestCount} ${req.method} ${req.path}`);
      }

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
      next();
    });

    expressApp.use(express.json({ limit: '10kb' }));
    
    // Serve basic info at root
    expressApp.get('/', (req, res) => {
      res.json({
        status: "running",
        app: "Air Quality Service",
        version: "1.1", // Updated version
        endpoints: [
          "/health",
          "/webhook",
          "/tpa_config.json"
        ]
      });
    });
    
    // Webhook handler
    const handleWebhook = async (req: express.Request, res: express.Response) => {
      if (!req.body?.type) {
        return res.status(400).json({ 
          status: 'error',
          message: 'Invalid request format'
        });
      }

      if (req.body.type === 'session_request') {
        try {
          await this.handleAugmentOSSession(req.body);
          res.json({ status: 'success' });
        } catch (error) {
          console.error('Webhook error:', error);
          res.status(500).json({ 
            status: 'error',
            message: 'Internal server error'
          });
        }
      } else {
        res.status(400).json({ 
          status: 'error',
          message: 'Unsupported request type'
        });
      }
    };

    expressApp.post('/webhook', handleWebhook);
    expressApp.post('/webbook', handleWebhook);

    // Health endpoint
    expressApp.get('/health', (req, res) => {
      res.json({ 
        status: "healthy",
        uptime: process.uptime(),
        activeSessions: this.activeSessions.size
      });
    });
  }
  
  private async handleAugmentOSSession(sessionData: SessionData) {
    console.log(`🗣️ Received session request for user ${sessionData.userId}, session ${sessionData.sessionId}`);
    try {
      const tpaSession = await this.initTpaSession({
        sessionId: sessionData.sessionId,
        userId: sessionData.userId,
        packageName: PACKAGE_NAME
      });

      console.log(`🚀 [${sessionData.sessionId}] TPA Session initialized`);
      console.log(`🚀 [${sessionData.sessionId}] WebSocket URL: ${tpaSession.wsUrl}`);
    } catch (error) {
      console.error(`❌ Failed to initialize TPA session:`, error);
      throw error;
    }
  }

  protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    console.log(`🌬️ Starting air quality session ${sessionId} for user ${userId}`);
    this.activeSessions.set(sessionId, { userId, started: new Date() });
    
    try {
      // Subscribe to transcriptions
      const cleanup = session.onTranscriptionForLanguage('en-US', (data) => {
        const transcript = data.text.toLowerCase();
        console.log(`🎤 Transcription received: "${transcript}"`);
        
        // Check if the transcript matches any voice command
        if (this.voiceCommands.some(cmd => transcript.includes(cmd.toLowerCase()))) {
          console.log(`🎤 Voice command detected: "${transcript}"`);
          this.checkAirQuality(session);
        }
      });
      
      // Initial air quality check
      await this.checkAirQuality(session);
      
      // Display hint about voice commands
      setTimeout(() => {
        session.layouts.showTextWall(
          "Say \"What's the air like?\" anytime to check current air quality", 
          { view: ViewType.SUBTLE, durationMs: 5000 }
        );
      }, 3000);
    } catch (error) {
      console.error(`Session ${sessionId} failed:`, error);
      session.layouts.showTextWall("Failed to check air quality", { view: ViewType.MAIN });
    }
  }
  
  private async checkAirQuality(session: TpaSession) {
    try {
      console.log("📍 Using default location (London)");
      await this.checkAirQualityForLocation(session, { latitude: 51.5074, longitude: -0.1278 }, "London (default)");
    } catch (error) {
      console.error('Air quality check failed:', error);
      await session.layouts.showTextWall("Failed to get air quality data", { 
        view: ViewType.MAIN,
        durationMs: 5000
      });
    }
  }
  
  private async checkAirQualityForLocation(
    session: TpaSession, 
    location: { latitude: number, longitude: number }, 
    locationName?: string
  ) {
    try {
      const aqiData = await this.fetchAQI(location.latitude, location.longitude);
      const quality = AQI_LEVELS.find(l => aqiData.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];
      
      const cityName = locationName || aqiData.city;
      const message = `📍 ${cityName}\n\nAir Quality: ${quality.label} ${quality.emoji}\nAQI: ${aqiData.aqi}\n\n${quality.advice}`;
      
      await session.layouts.showTextWall(message, { 
        view: ViewType.MAIN, 
        durationMs: 15000 
      });
    } catch (error) {
      console.error('AQI data retrieval failed:', error instanceof Error ? error.message : error);
      await session.layouts.showTextWall("Failed to get air quality data for your location", { 
        view: ViewType.MAIN,
        durationMs: 5000
      });
    }
  }

  private async fetchAQI(lat: number, lng: number): Promise<{ aqi: number; city: string }> {
    try {
      const { data } = await axios.get<{ data: AQIData }>(
        `https://api.waqi.info/feed/geo:${lat};${lng}/?token=${AQI_TOKEN}`,
        { timeout: 5000 }
      );
      
      if (!data.data || typeof data.data.aqi !== 'number') {
        throw new Error('Invalid AQI data received');
      }
      
      return {
        aqi: data.data.aqi,
        city: data.data.city?.name || 'Unknown location'
      };
    } catch (error) {
      console.error('AQI API error:', error instanceof Error ? error.message : error);
      throw new Error('Failed to fetch AQI data');
    }
  }
}

// Startup
console.log('🚀 Starting Air Quality App...');
const airQualityApp = new AirQualityApp();
airQualityApp.start().then(() => {
  console.log(`✅ Server running on port ${PORT}`);
}).catch((error) => {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
});