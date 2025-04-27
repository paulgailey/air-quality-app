import 'dotenv/config';
// Only set WebSocket once, don't overwrite if already exists
if (!(global as any).WebSocket) {
  (global as any).WebSocket = WebSocket;
}
import express from 'express';
import path from 'path';
import { TpaServer, TpaSession, ViewType } from '@augmentos/sdk';
import axios from 'axios';
import crypto from 'crypto';
import { readFileSync } from 'fs';

// Augmentos SDK Type Extensions
declare module '@augmentos/sdk' {
  interface TpaSession {
    location?: {
      latitude: number;
      longitude: number;
    };
  }
}

// Cross-platform path handling
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.resolve(__dirname, '../package.json');

// Configuration
const packageJson = JSON.parse(
  readFileSync(packageJsonPath, 'utf-8')
);
const APP_VERSION = packageJson.version;
const PACKAGE_NAME = 'air-quality-app'; // Hardcoded to match Augmentos console
const AUGMENTOS_API_KEY = process.env.AUGMENTOS_API_KEY as string;
const AQI_TOKEN = process.env.AQI_TOKEN as string;

// Validate environment
if (!AUGMENTOS_API_KEY || !AQI_TOKEN) {
  console.error('❌ Missing required environment variables');
  process.exit(1);
}

// AQI Levels
const AQI_LEVELS = [
  { max: 50, label: "Good", emoji: "😊", advice: "Perfect for outdoor activities!" },
  { max: 100, label: "Moderate", emoji: "😐", advice: "Acceptable air quality" },
  { max: 150, label: "Unhealthy for Sensitive Groups", emoji: "😷", advice: "Reduce prolonged exertion" },
  { max: 200, label: "Unhealthy", emoji: "😨", advice: "Wear a mask outdoors" },
  { max: 300, label: "Very Unhealthy", emoji: "⚠️", advice: "Limit outdoor exposure" },
  { max: Infinity, label: "Hazardous", emoji: "☢️", advice: "Stay indoors with windows closed" }
];

interface AQIStationData {
  aqi: number;
  station: {
    name: string;
    geo: [number, number];
  };
}

class AirQualityApp {
  private server: TpaServer;
  private requestCount = 0;
  private readonly VOICE_COMMANDS = [
    "air quality",
    "what's the air like",
    "pollution",
    "how clean is the air",
    "is the air safe",
    "nearest air quality station"
  ];
  private sessionHandler?: (session: TpaSession, sessionId: string, userId: string) => Promise<void>;

  constructor() {
    this.server = new TpaServer({
      packageName: PACKAGE_NAME,
      apiKey: AUGMENTOS_API_KEY,
      publicDir: path.join(__dirname, '../public')
    });

    // Store session handler reference
    this.sessionHandler = this.handleSession.bind(this);
    
    // Direct assignment with type safety
    Object.assign(this.server, {
      onSession: this.sessionHandler
    });
    
    this.setupRoutes();
  }

  getExpressApp() {
    return this.server.getExpressApp();
  }

  private setupRoutes(): void {
    const app = this.getExpressApp();

    app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
      this.requestCount++;
      const requestId = crypto.randomUUID();
      res.set('X-Request-ID', requestId);
      console.log(`[${new Date().toISOString()}] REQ#${this.requestCount} ${req.method} ${req.path}`);
      next();
    });
    
    app.use(express.json());

    app.use('/public', express.static(path.join(__dirname, '../public')));

    app.get('/', (req: express.Request, res: express.Response) => {
      res.json({
        status: "running",
        version: APP_VERSION,
        endpoints: ['/health', '/tpa_config.json']
      });
    });

    app.get('/health', (req: express.Request, res: express.Response) => {
      res.json({
        status: "healthy",
        sessions: 0
      });
    });

    app.get('/tpa_config.json', (req: express.Request, res: express.Response) => {
      res.json({
        voiceCommands: this.VOICE_COMMANDS.map(phrase => ({
          phrase,
          description: "Check air quality"
        })),
        permissions: ["location"],
        transcriptionLanguages: ["en-US"]
      });
    });

    app.post('/webhook', async (req: express.Request, res: express.Response) => {
      if (req.body?.type === 'session_request') {
        try {
          console.log('Session request received:', req.body.sessionId);
          res.json({ status: 'success' });
        } catch (error) {
          console.error('Session init failed:', error);
          res.status(500).json({ status: 'error' });
        }
      } else {
        res.status(400).json({ status: 'error' });
      }
    });
  }

  private async handleSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    session.onTranscriptionForLanguage('en-US', (transcript) => {
      const text = transcript.text.toLowerCase();
      console.log(`🎤 Heard: "${text}"`);
      if (this.VOICE_COMMANDS.some(cmd => text.includes(cmd.toLowerCase()))) {
        this.checkAirQuality(session).catch(console.error);
      }
    });

    await this.checkAirQuality(session);
  }

  private async getNearestAQIStation(lat: number, lon: number): Promise<AQIStationData> {
    try {
      const response = await axios.get(
        `https://api.waqi.info/feed/geo:${lat};${lon}/?token=${AQI_TOKEN}`,
        { timeout: 3000,
          headers: {
            'Accept-Encoding': 'gzip, deflate'
          }
         }
      );
      if (response.data.status !== 'ok') {
        throw new Error(response.data.data || 'Station data unavailable');
      }
      return {
        aqi: response.data.data.aqi,
        station: {
          name: response.data.data.city?.name || 'Nearest AQI station',
          geo: response.data.data.city?.geo || [lat, lon]
        }
      };
    } catch (error) {
      console.error('AQI station fetch failed:', error);
      throw error;
    }
  }

  private async checkAirQuality(session: TpaSession): Promise<void> {
    try {
      const coords = session.location 
        ? { lat: session.location.latitude, lon: session.location.longitude }
        : await this.getApproximateCoords();
      
      const station = await this.getNearestAQIStation(coords.lat, coords.lon);
      const quality = AQI_LEVELS.find(l => station.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];
      
      await session.layouts.showTextWall(
        `📍 ${station.station.name}\n\n` +
        `Air Quality: ${quality.label} ${quality.emoji}\n` +
        `AQI: ${station.aqi}\n\n` +
        `${quality.advice}`,
        { view: ViewType.MAIN, durationMs: 10000 }
      );
    } catch (error) {
      console.error("Check failed:", error);
      await session.layouts.showTextWall("Air quality unavailable", { 
        view: ViewType.MAIN,
        durationMs: 3000 
      });
    }
  }

  private async getApproximateCoords(): Promise<{ lat: number, lon: number }> {
    try {
      const ip = await axios.get('https://ipapi.co/json/', { timeout: 2000 });
      if (ip.data.latitude && ip.data.longitude) {
        return { lat: ip.data.latitude, lon: ip.data.longitude };
      }
    } catch (error) {
      console.warn("IP geolocation failed:", error);
    }
    return { lat: 51.5074, lon: -0.1278 }; // London fallback
  }
}

// Create app instance
const server = new AirQualityApp();
const app = server.getExpressApp();

// Local development handling
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  app.listen(PORT, '0.0.0.0', () => {
      console.log(`✅ Server running on http://localhost:${PORT}`);
      console.log(`📂 Serving static files from ${path.join(__dirname, '../public')}`);
  });
}

// Export for Vercel (must keep this)
export default app;
// At the bottom of your file, replace the environment check:
const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
});