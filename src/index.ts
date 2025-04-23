import path from 'path';
import { TpaServer, TpaSession, ViewType } from '@augmentos/sdk';
import axios from 'axios';

// Configuration
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'com.everywoah.airquality';
const AUGMENTOS_API_KEY = process.env.AUGMENTOS_API_KEY!; // ✅ Only use .env
const AQI_TOKEN = process.env.AQI_TOKEN!; // ✅ Only use .env

// Air Quality Index Levels
const AQI_LEVELS = [
  { max: 50, label: "Good", emoji: "😊", advice: "Perfect for outdoor activities!" },
  { max: 100, label: "Moderate", emoji: "😐", advice: "Acceptable air quality" },
  { max: 150, label: "Unhealthy for Sensitive Groups", emoji: "😷", advice: "Reduce prolonged exertion" },
  { max: 200, label: "Unhealthy", emoji: "😨", advice: "Wear a mask outdoors" },
  { max: 300, label: "Very Unhealthy", emoji: "⚠️", advice: "Limit outdoor exposure" },
  { max: Infinity, label: "Hazardous", emoji: "☢️", advice: "Stay indoors with windows closed" }
];

/**
 * AirQualityApp - Main application class that extends TpaServer
 */
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
  
  /**
   * Setup additional HTTP routes for testing
   */
  private setupRoutes() {
    const expressApp = this.getExpressApp();
    
    expressApp.get('/health', (req, res) => {
      res.json({
        status: "healthy",
        service: "everywoah-air-quality",
        version: "1.0.0"
      });
    });
  
    // ✅ CORRECTLY PLACED ROOT ENDPOINT
    expressApp.get('/', (req, res) => {
      res.json({ 
        status: "running", 
        app: PACKAGE_NAME,
        endpoints: ["/health", "/onSession"] 
      });
    });
  }
  /**
   * Called by TpaServer when a new session is created
   */
  protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    console.log(`\n\n🌬️ New air quality session for user ${userId}, session ${sessionId}\n\n`);

    // Register voice commands
    this.setupVoiceCommands(session);
    
    // Initial air quality check
    await this.checkAirQuality(session);
  }
  
  /**
   * Sets up voice command listeners
   */
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
    
    for (const command of commands) {
      session.onVoiceCommand(command, async () => {
        console.log(`Received voice command: "${command}"`);
        await this.checkAirQuality(session);
      });
    }
  }
  
  /**
   * Checks air quality at user's location
   */
  private async checkAirQuality(session: TpaSession) {
    try {
      // First, show loading message
      session.layouts.showTextWall("Checking air quality...", {
        view: ViewType.MAIN,
        durationMs: 3000,
      });
      
      // Get user location
      const location = await session.getUserLocation();
      
      if (!location || !location.latitude || !location.longitude) {
        throw new Error("Couldn't get your location");
      }
      
      console.log(`Got user location: ${location.latitude}, ${location.longitude}`);
      
      // Fetch AQI data
      const aqiData = await this.fetchAQI(location.latitude, location.longitude);
      
      // Find quality level
      const quality = AQI_LEVELS.find(l => aqiData.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];
      
      // Display result
      const message = `At ${aqiData.city.name}: 
Air quality is ${quality.label} ${quality.emoji} 
(AQI ${aqiData.aqi})

${quality.advice}`;
      
      session.layouts.showTextWall(message, {
        view: ViewType.MAIN,
        durationMs: 15000,
      });
      
      console.log(`Displayed air quality for ${aqiData.city.name}: AQI ${aqiData.aqi} (${quality.label})`);
    } catch (error) {
      console.error('Error in checkAirQuality:', error);
      session.layouts.showTextWall("Sorry, I couldn't retrieve air quality information.", {
        view: ViewType.MAIN,
        durationMs: 5000,
      });
    }
  }

  /**
   * Fetch AQI data with error handling
   */
  private async fetchAQI(lat: number, lng: number) {
    try {
      console.log(`Fetching AQI data for ${lat}, ${lng}`);
      const { data } = await axios.get(
        `https://api.waqi.info/feed/geo:${lat};${lng}/?token=${AQI_TOKEN}`,
        { timeout: 10000 }
      );
      
      if (data.status !== 'ok' || !data.data) {
        throw new Error(`API returned error: ${data.status}`);
      }
      
      console.log('AQI data received:', JSON.stringify(data.data, null, 2));
      return data.data;
    } catch (error) {
      console.error('AQI API Error:', error);
      throw new Error('Failed to fetch air quality data');
    }
  }

  /**
   * Called by TpaServer when a session is stopped
   */
  protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
    console.log(`Session ${sessionId} stopped: ${reason}`);
  }
}

// Create and start the app
const airQualityApp = new AirQualityApp();

airQualityApp.start().then(() => {
  console.log(`
✅ Air Quality App server running on port ${PORT}
- Local: http://localhost:${PORT}
- Health check: http://localhost:${PORT}/health

App is ready to receive voice commands:
- "air quality"
- "what's the air like"
- "pollution"
- "air pollution"
- "is the air clean"
- "is the air dirty"
- "how clean is the air"
`);
}).catch(error => {
  console.error('Failed to start server:', error);
});
