import 'dotenv/config';
import express from 'express';
import path from 'path';
import { TpaServer, TpaSession, ViewType, StreamType } from '@augmentos/sdk';
import axios from 'axios';
import crypto from 'crypto';
import { readFileSync } from 'fs';

// Configuration
const packageJson = JSON.parse(
  readFileSync(path.join(__dirname, '../package.json'), 'utf-8')
);

const APP_VERSION = packageJson.version;
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'com.everywoah.airquality';
const AUGMENTOS_API_KEY = process.env.AUGMENTOS_API_KEY;
const AQI_TOKEN = process.env.AQI_TOKEN;
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

  private setupRoutes(): void {
    const expressApp = this.getExpressApp();

    expressApp.get('/health', (req, res) => {
      res.json({ 
        status: "healthy",
        uptime: process.uptime(),
        activeSessions: this.activeSessions.size,
        memory: process.memoryUsage()
      });
    });

    expressApp.get('/tpa_config.json', (req, res) => {
      res.json({
        voiceCommands: this.voiceCommands.map(phrase => ({
          phrase,
          description: "Check air quality information"
        })),
        permissions: ["location", "voice"],
        transcriptionLanguages: ["en-US"],
        streamAccess: [StreamType.TRANSCRIPTION]
      });
    });

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

    expressApp.use((req, res, next) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Access-Control-Allow-Headers", "Content-Type, X-AugmentOS-Signature");
      res.header("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
      next();
    });

    expressApp.use(express.json({ limit: '10kb' }));

    expressApp.get('/', (req, res) => {
      res.json({
        status: "running",
        app: "Air Quality Service",
        version: APP_VERSION,
        endpoints: [
          "/health",
          "/webhook",
          "/tpa_config.json"
        ]
      });
    });

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
  }

  private async handleAugmentOSSession(sessionData: SessionData): Promise<void> {
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
      const cleanup = session.onTranscriptionForLanguage('en-US', (data) => {
        const transcript = data.text.toLowerCase();
        console.log(`🎤 Transcription received: "${transcript}"`);
        if (this.voiceCommands.some(cmd => transcript.includes(cmd.toLowerCase()))) {
          console.log(`🎤 Voice command detected: "${transcript}"`);
          this.checkAirQuality(session);
        }
      });

      await this.checkAirQuality(session);

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

  private async reverseGeocode(lat: number, lon: number): Promise<string> {
    try {
      const response = await axios.get(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`,
        { timeout: 3000 }
      );
      return response.data.address?.city || 
             response.data.address?.town || 
             response.data.address?.county || 
             'Your location';
    } catch (error) {
      console.warn('Geocoding failed:', error instanceof Error ? error.message : error);
      return 'Your area';
    }
  }

  private async getApproximateLocation(): Promise<{latitude: number, longitude: number}> {
    try {
      const response = await axios.get('https://ipapi.co/json/', { timeout: 3000 });
      if (response.data.latitude && response.data.longitude) {
        console.log(`🌍 Using approximate IP-based location: ${response.data.latitude}, ${response.data.longitude}`);
        return {
          latitude: response.data.latitude,
          longitude: response.data.longitude
        };
      }
    } catch (error) {
      console.warn('IP geolocation failed:', error instanceof Error ? error.message : error);
    }
    
    console.warn('⚠️ Using ultimate fallback to London');
    return { latitude: 51.5074, longitude: -0.1278 };
  }

  private async checkAirQuality(session: TpaSession): Promise<void> {
    try {
      console.log('📍 Attempting to get precise user location...');
      
      // Increase timeout and add better debugging
      const location = await Promise.race([
        session.getUserLocation()
          .then(loc => {
            console.log(`✅ Location service returned: ${JSON.stringify(loc)}`);
            return loc;
          }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Precise location timeout after 15s")), 15000)
        )
      ]);
      
      // Add more validation of the location data
      if (!location?.latitude || !location?.longitude ||
          Math.abs(location.latitude) > 90 || 
          Math.abs(location.longitude) > 180) {
        throw new Error(`Invalid location: ${JSON.stringify(location)}`);
      }
      
      console.log(`📍 Obtained precise location: ${location.latitude}, ${location.longitude}`);
      const cityName = await this.reverseGeocode(location.latitude, location.longitude);
      await this.checkAirQualityForLocation(session, location, cityName);
      
    } catch (error) {
      console.error('⚠️ Location error:', error instanceof Error ? error.message : error);
      console.error('⚠️ Falling back to IP geolocation');
      
      // Make sure IP geolocation has proper error handling
      try {
        const fallbackLocation = await this.getApproximateLocation();
        const fallbackCity = await this.reverseGeocode(fallbackLocation.latitude, fallbackLocation.longitude);
        await this.checkAirQualityForLocation(session, fallbackLocation, fallbackCity);
      } catch (ipError) {
        console.error('⚠️ IP geolocation failed:', ipError instanceof Error ? ipError.message : ipError);
        // Now use London as last resort
        await this.checkAirQualityForLocation(
          session, 
          { latitude: 51.5074, longitude: -0.1278 },
          'London (fallback)'
        );
      }
    }
  }

  private async checkAirQualityForLocation(
    session: TpaSession,
    location: { latitude: number; longitude: number },
    locationName?: string
  ): Promise<void> {
    try {
      await session.layouts.showTextWall("Checking air quality...", {
        view: ViewType.MAIN,
        durationMs: 2000
      });

      const aqiData = await this.fetchAQI(location.latitude, location.longitude);
      const quality = AQI_LEVELS.find(l => aqiData.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];
      const cityName = locationName || aqiData.city.name;
      const message = `📍 ${cityName}\n\n` +
                     `Air Quality: ${quality.label} ${quality.emoji}\n` +
                     `AQI Index: ${aqiData.aqi}\n\n` +
                     `Recommendation: ${quality.advice}`;

      await session.layouts.showTextWall(message, { 
        view: ViewType.MAIN, 
        durationMs: 15000 
      });
    } catch (error) {
      console.error('AQI retrieval failed:', error instanceof Error ? error.message : error);
      await session.layouts.showTextWall("Failed to get air quality data", { 
        view: ViewType.MAIN,
        durationMs: 5000
      });
    }
  }

  private async fetchAQI(lat: number, lon: number): Promise<AQIData> {
    const url = `https://api.waqi.info/feed/geo:${lat};${lon}/?token=${AQI_TOKEN}`;
    try {
      const response = await axios.get(url, { timeout: 5000 });
      
      if (response.data.status !== 'ok') {
        throw new Error(`API error: ${response.data.data}`);
      }

      if (typeof response.data.data?.aqi !== 'number') {
        throw new Error('Invalid AQI data format');
      }

      return {
        aqi: response.data.data.aqi,
        city: {
          name: response.data.data.city?.name || 'Your location',
          geo: [lat, lon],
          url: `https://waqi.info/#/c/${lat}/${lon}/10z`
        }
      };
    } catch (error) {
      console.error('AQI API failed:', error instanceof Error ? error.message : error);
      throw new Error('Could not retrieve air quality data');
    }
  }
}

// Server initialization
try {
  const server = new AirQualityApp();
  const expressInstance = server.getExpressApp();
  
  expressInstance.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on:
    - http://localhost:${PORT}
    - http://127.0.0.1:${PORT}
    - http://0.0.0.0:${PORT}`);
  }).on('error', (err) => {
    console.error('❌ Server failed to start:', err);
    process.exit(1);
  });

  process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
  });
} catch (err) {
  console.error('❌ Startup failed:', err);
  process.exit(1);
}