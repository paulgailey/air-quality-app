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
  
    // Middleware for parsing JSON
    expressApp.use(express.json());
  
    // Root endpoint
    expressApp.get('/', (req, res) => {
      res.json({ 
        status: "running", 
        app: PACKAGE_NAME,
        endpoints: ["/health", "/webhook", "/webbook"],
        note: "Using /webbook temporarily for AugmentOS compatibility"
      });
    });
    
    // Health check endpoint
    expressApp.get('/health', (req, res) => {
      res.json({
        status: "healthy",
        service: "everywoah-air-quality",
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || "development"
      });
    });
  
    // Unified webhook handler for both endpoints
    expressApp.post('/webhook', (req, res) => this.handleWebhook(req, res));
    expressApp.post('/webbook', (req, res) => this.handleWebhook(req, res));
  }
  
  private handleWebhook(req: express.Request, res: express.Response) {
    console.log('Incoming webhook request:', {
      path: req.path,
      headers: req.headers,
      body: req.body
    });

    // Validate request format
    if (!req.body || typeof req.body !== 'object') {
      console.error('Invalid webhook payload format');
      return res.status(400).json({
        status: "error",
        message: "Invalid request format",
        required_format: {
          type: "string",
          sessionId: "string",
          userId: "string",
          timestamp: "ISO8601"
        }
      });
    }

    // Handle different webhook types
    switch (req.body.type) {
      case 'session_request':
        console.log('Processing session request:', req.body.sessionId);
        try {
          this.handleAugmentOSSession(req.body);
          return res.json({
            status: "success",
            sessionId: req.body.sessionId,
            processedAt: new Date().toISOString()
          });
        } catch (error) {
          console.error('Session processing failed:', error);
          return res.status(500).json({
            status: "error",
            message: "Failed to process session",
            error: error.message
          });
        }

      default:
        console.warn('Unknown webhook type:', req.body.type);
        return res.status(400).json({
          status: "error",
          message: "Unknown webhook type",
          supported_types: ["session_request"]
        });
    }
  }
  
  private handleAugmentOSSession(sessionData: any) {
    if (!sessionData.sessionId || !sessionData.userId) {
      throw new Error("Missing required session data");
    }

    console.log('Creating session:', {
      sessionId: sessionData.sessionId,
      userId: sessionData.userId,
      timestamp: sessionData.timestamp || new Date().toISOString()
    });

    const mockSession = {
      layouts: {
        showTextWall: (text: string, options: any) => {
          console.log(`[DISPLAY]: ${text}`, options);
        }
      },
      onVoiceCommand: (command: string, callback: () => void) => {
        console.log(`[VOICE COMMAND]: Registered "${command}"`);
        callback();
      },
      getUserLocation: async () => {
        console.log('[LOCATION] Fetching user location');
        return {
          latitude: 51.5074,  // Default to London coordinates
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
    console.log(`\n🌬️ Starting air quality session for ${userId} (${sessionId})\n`);
    
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
          console.error('Voice command processing failed:', error);
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
      // Show loading message
      session.layouts.showTextWall("Checking air quality...", {
        view: ViewType.MAIN,
        durationMs: 2000
      });

      // Get location with timeout
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
      
      // Fetch AQI data
      const aqiData = await this.fetchAQI(location.latitude, location.longitude);
      const quality = AQI_LEVELS.find(l => aqiData.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];
      
      // Format display message
      const message = `At ${aqiData.city.name}:\n` +
                     `Air Quality: ${quality.label} ${quality.emoji}\n` +
                     `AQI Index: ${aqiData.aqi}\n\n` +
                     `Recommendation: ${quality.advice}`;
      
      // Display results
      session.layouts.showTextWall(message, {
        view: ViewType.MAIN,
        durationMs: 10000
      });

      console.log(`Displayed AQI ${aqiData.aqi} (${quality.label})`);
    } catch (error) {
      console.error('Air quality check failed:', error);
      session.layouts.showTextWall("Sorry, couldn't get air quality data", {
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

// Application startup
const airQualityApp = new AirQualityApp();

airQualityApp.start()
  .then(() => {
    console.log(`
✅ Air Quality App successfully started
───────────────────────────────────────
• Local URL: http://localhost:${PORT}
• Health Check: http://localhost:${PORT}/health
• Webhook Endpoint: http://localhost:${PORT}/webhook
• Typo Endpoint: http://localhost:${PORT}/webbook

Supported Voice Commands:
${[
  "air quality",
  "what's the air like",
  "pollution",
  "air pollution", 
  "is the air clean",
  "is the air dirty",
  "how clean is the air"
].map(cmd => `• "${cmd}"`).join('\n')}
───────────────────────────────────────
Note: The /webbook endpoint is temporary
for AugmentOS compatibility.
`);
  })
  .catch(error => {
    console.error(`
🚨 Failed to start Air Quality App
───────────────────────────────────────
Error: ${error.message}

Check:
1. API keys in .env are valid
2. Port ${PORT} is available
3. All dependencies are installed
`);
    process.exit(1);
  });