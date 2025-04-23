import express from 'express';
import path from 'path';
import { TpaServer, TpaSession, ViewType } from '@augmentos/sdk';
import axios from 'axios';

// Configuration
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'com.everywoah.airquality';
const AUGMENTOS_API_KEY = process.env.AUGMENTOS_API_KEY!;
const AQI_TOKEN = process.env.AQI_TOKEN!;

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

    // Enable CORS for Android app
    expressApp.use((req, res, next) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Access-Control-Allow-Headers", "Content-Type, X-AugmentOS-Signature");
      next();
    });

    expressApp.use(express.json());

    // Unified webhook handler
    const handleWebhook = (req: express.Request, res: express.Response) => {
      console.log('Received webhook at:', req.path, 'Body:', req.body);
      
      if (!req.body?.type || req.body.type !== 'session_request') {
        console.warn('Invalid webhook payload:', req.body);
        return res.status(400).json({ 
          status: 'error',
          message: 'Invalid request type',
          supported_types: ['session_request']
        });
      }

      try {
        this.handleAugmentOSSession(req.body);
        res.json({ 
          status: 'success',
          sessionId: req.body.sessionId,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('Webhook processing failed:', error);
        res.status(500).json({
          status: 'error',
          message: 'Failed to process session',
          error: error.message
        });
      }
    };

    // Apply to both endpoints
    expressApp.post('/webhook', handleWebhook);
    expressApp.post('/webbook', handleWebhook);

    // Health check endpoint
    expressApp.get('/health', (req, res) => {
      res.json({
        status: "healthy",
        service: PACKAGE_NAME,
        version: "1.0.0",
        timestamp: new Date().toISOString()
      });
    });

    // Root endpoint
    expressApp.get('/', (req, res) => {
      res.json({ 
        status: "running",
        app: PACKAGE_NAME,
        endpoints: ["/health", "/webhook", "/webbook"],
        note: "Dual endpoints for AugmentOS compatibility"
      });
    });
  }
  
  private handleAugmentOSSession(sessionData: any) {
    if (!sessionData.sessionId || !sessionData.userId) {
      throw new Error("Missing required session fields");
    }

    console.log('Creating session:', {
      sessionId: sessionData.sessionId,
      userId: sessionData.userId,
      timestamp: sessionData.timestamp || new Date().toISOString()
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
      console.error(`Session ${sessionId} failed:`, error);
      session.layouts.showTextWall("Session error - please try again", {
        view: ViewType.MAIN,
        durationMs: 5000
      });
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
        console.log(`Voice command received: "${command}"`);
        try {
          await this.checkAirQuality(session);
        } catch (error) {
          console.error('Command processing failed:', error);
          session.layouts.showTextWall("Sorry, I couldn't check air quality", {
            view: ViewType.MAIN,
            durationMs: 3000
          });
        }
      });
    });
  }
  
  private async checkAirQuality(session: TpaSession) {
    try {
      session.layouts.showTextWall("Checking air quality...", {
        view: ViewType.MAIN,
        durationMs: 2000
      });

      const location = await Promise.race([
        session.getUserLocation(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Location timeout")), 5000)
        )
      ]);

      if (!location?.latitude || !location?.longitude) {
        throw new Error("Invalid location data");
      }

      console.log('Fetching AQI for:', location.latitude, location.longitude);
      
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

      console.log(`Displayed AQI ${aqiData.aqi} (${quality.label})`);
    } catch (error) {
      console.error('Air quality check failed:', error);
      session.layouts.showTextWall("Air quality data unavailable", {
        view: ViewType.MAIN,
        durationMs: 5000
      });
      throw error;
    }
  }

  private async fetchAQI(lat: number, lng: number) {
    try {
      console.log(`Calling WAQI API for ${lat},${lng}`);
      const { data } = await axios.get(
        `https://api.waqi.info/feed/geo:${lat};${lng}/?token=${AQI_TOKEN}`,
        { 
          timeout: 8000,
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'AugmentOS-AirQuality/1.0'
          }
        }
      );
      
      if (data.status !== 'ok' || !data.data) {
        throw new Error(`API error: ${data.status || 'No data'}`);
      }
      
      return {
        aqi: data.data.aqi,
        city: data.data.city,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('WAQI API call failed:', error);
      throw new Error(`Air quality service unavailable: ${error.message}`);
    }
  }

  protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
    console.log(`Session ${sessionId} ended (Reason: ${reason})`);
  }
}

// Startup
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

Check:
1. Port ${PORT} is available
2. .env contains valid API keys
3. Dependencies are installed
`);
    process.exit(1);
  });