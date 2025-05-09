import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { TpaServer, TpaSession, ViewType } from '@augmentos/sdk';
import axios from 'axios';
import crypto from 'crypto';
import { readFileSync } from 'fs';

// Configuration
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(path.join(__dirname, '../package.json'), 'utf-8')
);
const APP_VERSION = packageJson.version;
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
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

// Extend TpaSession interface to include location
declare module '@augmentos/sdk' {
  interface TpaSession {
    location?: {
      latitude: number;
      longitude: number;
    };
  }
}

class AirQualityApp extends TpaServer {
  private _activeSessions = new Map<string, { userId: string; started: Date }>();
  private requestCount = 0;
  private readonly VOICE_COMMANDS = [
    "air quality",
    "what's the air like",
    "pollution",
    "how clean is the air",
    "is the air safe",
    "nearest air quality station"
  ];

  constructor() {
    super({
      packageName: "air-quality-app", // Hardcoded to match Augmentos configuration
      apiKey: AUGMENTOS_API_KEY,
      port: PORT,
      publicDir: path.join(__dirname, '../public'),
    });
    this.setupRoutes();
  }

  private setupRoutes(): void {
    const app = this.getExpressApp();

    // Ngrok header middleware (must be first)
    app.use((req, res, next) => {
      res.setHeader('ngrok-skip-browser-warning', 'true');
      next();
    });

    app.use((req, res, next) => {
      this.requestCount++;
      const requestId = crypto.randomUUID();
      res.set('X-Request-ID', requestId);
      console.log(`[${new Date().toISOString()}] REQ#${this.requestCount} ${req.method} ${req.path}`);
      next();
    });
    app.use(express.json());

    app.get('/', (req, res) => {
      res.json({
        status: "running",
        version: APP_VERSION,
        endpoints: ['/health', '/tpa_config.json']
      });
    });

    app.get('/health', (req, res) => {
      res.json({
        status: "healthy",
        sessions: this._activeSessions.size
      });
    });

    app.get('/tpa_config.json', (req, res) => {
      res.json({
        voiceCommands: this.VOICE_COMMANDS.map(phrase => ({
          phrase,
          description: "Check air quality"
        })),
        permissions: ["location"],
        transcriptionLanguages: ["en-US"]
      });
    });

    app.post('/webhook', async (req, res) => {
      if (req.body?.type === 'session_request') {
        try {
          await this.handleNewSession(req.body.sessionId, req.body.userId);
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

  private async handleNewSession(sessionId: string, userId: string): Promise<void> {
    console.log(`Initializing new session: ${sessionId} for user ${userId}`);
  }

  protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    this._activeSessions.set(sessionId, { userId, started: new Date() });

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
        { timeout: 3000 }
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

// Server Startup
new AirQualityApp().getExpressApp().listen(PORT, () => {
  console.log(`✅ Air Quality v${APP_VERSION} running on port ${PORT}`);
  console.log(`Configure ngrok with: ngrok http ${PORT}`);
});