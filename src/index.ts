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
    
    // Health check
    expressApp.get('/health', (req, res) => {
      res.json({
        status: "healthy",
        service: "everywoah-air-quality",
        version: "1.0.0",
        timestamp: new Date().toISOString()
      });
    });
  
    // Standard webhook endpoint
    expressApp.post('/webhook', (req, res) => {
      console.log('Standard webhook received:', req.body);
      this.handleAugmentOSSession(req.body);
      res.json({ 
        status: 'success',
        message: 'Webhook processed',
        timestamp: new Date().toISOString()
      });
    });
    
    // Temporary typo endpoint
    expressApp.post('/webbook', (req, res) => {
      console.log('Typo webhook received:', req.body);
      this.handleAugmentOSSession(req.body);
      res.json({ 
        status: 'success',
        message: 'Webhook processed (typo endpoint)',
        timestamp: new Date().toISOString()
      });
    });
  }
  
  private handleAugmentOSSession(sessionData: any) {
    console.log('Processing session:', {
      type: sessionData.type,
      sessionId: sessionData.sessionId,
      userId: sessionData.userId,
      timestamp: sessionData.timestamp
    });
    
    // Create a mock session for demonstration
    const mockSession = {
      layouts: {
        showTextWall: (text: string, options: any) => {
          console.log(`[MOCK DISPLAY]: ${text}`, options);
        }
      },
      onVoiceCommand: (command: string, callback: () => void) => {
        console.log(`[MOCK VOICE]: Registered command '${command}'`);
      },
      getUserLocation: async () => ({
        latitude: 51.5074,
        longitude: -0.1278,
        accuracy: 50
      })
    };
    
    this.onSession(
      mockSession as unknown as TpaSession,
      sessionData.sessionId,
      sessionData.userId
    );
  }

  protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    console.log(`\n🌬️ New session for ${userId} (${sessionId})\n`);
    
    this.setupVoiceCommands(session);
    await this.checkAirQuality(session);
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
        console.log(`Voice command triggered: "${command}"`);
        await this.checkAirQuality(session);
      });
    });
  }
  
  private async checkAirQuality(session: TpaSession) {
    try {
      session.layouts.showTextWall("Checking air quality...", {
        view: ViewType.MAIN,
        durationMs: 3000,
      });
      
      const location = await session.getUserLocation();
      console.log('User location:', location);
      
      if (!location?.latitude || !location?.longitude) {
        throw new Error("Location unavailable");
      }
      
      const aqiData = await this.fetchAQI(location.latitude, location.longitude);
      const quality = AQI_LEVELS.find(l => aqiData.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];
      
      const message = `At ${aqiData.city.name}:\n` +
                     `Air quality is ${quality.label} ${quality.emoji}\n` +
                     `(AQI ${aqiData.aqi})\n\n` +
                     `${quality.advice}`;
      
      session.layouts.showTextWall(message, {
        view: ViewType.MAIN,
        durationMs: 15000,
      });
      
      console.log(`Displayed AQI ${aqiData.aqi} (${quality.label}) for ${aqiData.city.name}`);
    } catch (error) {
      console.error('Air quality check failed:', error);
      session.layouts.showTextWall("Sorry, I couldn't retrieve air quality data.", {
        view: ViewType.MAIN,
        durationMs: 5000,
      });
    }
  }

  private async fetchAQI(lat: number, lng: number) {
    try {
      console.log(`Fetching AQI for ${lat},${lng}`);
      const { data } = await axios.get(
        `https://api.waqi.info/feed/geo:${lat};${lng}/?token=${AQI_TOKEN}`,
        { timeout: 10000 }
      );
      
      if (data.status !== 'ok') {
        throw new Error(`API error: ${data.status}`);
      }
      
      return data.data;
    } catch (error) {
      console.error('AQI API failed:', error);
      throw new Error('Failed to fetch air quality data');
    }
  }

  protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
    console.log(`Session ${sessionId} ended: ${reason}`);
  }
}

// Startup
const airQualityApp = new AirQualityApp();

airQualityApp.start().then(() => {
  console.log(`
✅ Server running on port ${PORT}
• Local: http://localhost:${PORT}
• Health: http://localhost:${PORT}/health
• Webhook: http://localhost:${PORT}/webhook
• Typo Endpoint: http://localhost:${PORT}/webbook

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
}).catch(error => {
  console.error('🚨 Failed to start:', error);
});