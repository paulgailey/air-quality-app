// Version 2.0.5 - Complete production-ready version
import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { TpaServer, TpaSession, ViewType } from '@augmentos/sdk';
import axios from 'axios';
import crypto from 'crypto';
import { readFileSync, existsSync } from 'fs';

// Configuration
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(__dirname, '../config.json'), 'utf-8'));
const APP_VERSION = "2.0.5";
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Validate and assert environment variables
const AUGMENTOS_API_KEY = process.env.AUGMENTOS_API_KEY;
const AQI_TOKEN = process.env.AQI_TOKEN;

if (!AUGMENTOS_API_KEY || !AQI_TOKEN) {
  console.error('❌ Missing required environment variables');
  process.exit(1);
}

// AQI Levels
interface AQILevel {
  max: number;
  label: string;
  emoji: string;
  advice: string;
}

const AQI_LEVELS: AQILevel[] = [
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

interface LocationUpdate {
  coords: {
    latitude: number;
    longitude: number;
  };
}

declare module '@augmentos/sdk' {
  interface TpaSession {
    location?: {
      latitude: number;
      longitude: number;
    };
    audio?: {
      play(path: string): Promise<void>;
      speak?(text: string, options?: { language?: string }): Promise<void>;
    };
    onLocation?(callback: (update: LocationUpdate) => void): void;
  }
}

class AirQualityApp extends TpaServer {
  private sessionTracker = new Map<string, { userId: string; started: Date }>();
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
      packageName: "air-quality-app",
      apiKey: AUGMENTOS_API_KEY as string,
      port: PORT,
      publicDir: path.join(__dirname, '../public'),
    });
    this.setupRoutes();
  }

  private setupRoutes(): void {
    const app = this.getExpressApp();

    // Configure proxy trust for Render
    app.set('trust proxy', process.env.TRUST_PROXY ? 1 : false);

    // Debug endpoint
    app.get('/debug/location', (req: Request, res: Response) => {
      res.json({
        headers: req.headers,
        ip: req.ip,
        xForwardedFor: req.headers['x-forwarded-for'],
        augmentosLocation: req.headers['x-augmentos-location']
      });
    });

    // Strict location policy
    if (process.env.ENFORCE_AUGMENTOS_LOCATION === 'true') {
      app.use((req: Request, res: Response, next: NextFunction) => {
        if (req.path !== '/health' && !req.headers['x-augmentos-location']) {
          res.status(403).json({ 
            error: "Location must come from AugmentOS SDK" 
          });
          return;
        }
        next();
      });
    }

    app.get('/favicon.ico', (req: Request, res: Response) => {
      res.status(204).end();
    });

    app.use((req: Request, res: Response, next: NextFunction) => {
      res.setHeader('ngrok-skip-browser-warning', 'true');
      next();
    });

    app.use((req: Request, res: Response, next: NextFunction) => {
      this.requestCount++;
      const requestId = crypto.randomUUID();
      res.set('X-Request-ID', requestId);
      console.log(`[${new Date().toISOString()}] REQ#${this.requestCount} ${req.method} ${req.path}`);
      next();
    });

    app.use(express.json());

    app.get('/', (req: Request, res: Response) => {
      res.json({
        status: "running",
        version: APP_VERSION,
        endpoints: ['/health', '/tpa_config.json']
      });
    });

    app.get('/health', (req: Request, res: Response) => {
      res.json({
        status: "healthy",
        sessions: this.sessionTracker.size,
        trustProxy: app.get('trust proxy')
      });
    });

    app.get('/tpa_config.json', (req: Request, res: Response) => {
      res.json({
        voiceCommands: this.VOICE_COMMANDS.map(phrase => ({
          phrase,
          description: "Check air quality"
        })),
        permissions: ["location", "audio"],
        transcriptionLanguages: ["en-US"]
      });
    });

    app.post('/webhook', async (req: Request, res: Response) => {
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
    this.sessionTracker.set(sessionId, { userId, started: new Date() });

    if (session.onLocation) {
      session.onLocation((update: LocationUpdate) => {
        const trueLocation = {
          lat: update.coords.latitude,
          lon: update.coords.longitude,
          source: "augmentos_gps"
        };
        console.log("📍 Verified location:", trueLocation);
        this.checkAirQuality(session, trueLocation).catch(console.error);
      });
    }

    session.onTranscriptionForLanguage('en-US', (transcript) => {
      const text = transcript.text.toLowerCase();
      console.log(`🎤 Heard: "${text}"`);
      if (this.VOICE_COMMANDS.some(cmd => text.includes(cmd.toLowerCase()))) {
        this.checkAirQuality(session).catch(console.error);
      }
    });

    const fallbackCoords = await this.getApproximateCoords();
    console.warn("⚠️ Using fallback location:", {
      ...fallbackCoords,
      source: "ip_geolocation"
    });
    await this.checkAirQuality(session, fallbackCoords);
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

  private async checkAirQuality(
    session: TpaSession,
    coords?: { lat: number; lon: number }
  ): Promise<void> {
    try {
      const location = coords || (
        session.location
          ? { lat: session.location.latitude, lon: session.location.longitude }
          : await this.getApproximateCoords()
      );

      const station = await this.getNearestAQIStation(location.lat, location.lon);
      const quality = AQI_LEVELS.find(l => station.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];
      
      await session.layouts.showTextWall(
        `📍 ${station.station.name}\n\n` +
        `Air Quality: ${quality.label} ${quality.emoji}\n` +
        `AQI: ${station.aqi}\n\n` +
        `${quality.advice}`,
        { view: ViewType.MAIN, durationMs: 10000 }
      );

      if (session.audio?.play) {
        const audioBasePath = path.join(__dirname, '../public/audio/blip');
        const aqiLevel = quality.label.toLowerCase().split(' ')[0];
        const audioFiles = [
          path.join(audioBasePath, `${aqiLevel}.mp3`),
          path.join(audioBasePath, 'default.mp3')
        ];

        for (const audioFile of audioFiles) {
          if (existsSync(audioFile)) {
            try {
              await session.audio.play(audioFile);
              break;
            } catch (audioError) {
              console.error('Audio playback failed:', audioError);
            }
          }
        }
      }
    } catch (error) {
      console.error("Check failed:", error);
      await session.layouts.showTextWall("Air quality unavailable", { 
        view: ViewType.MAIN,
        durationMs: 3000 
      });
    }
  }

  private async getApproximateCoords(): Promise<{ lat: number, lon: number }> {
    if (process.env.DISABLE_IP_GEOLOCATION_FALLBACK === "true") {
      console.warn("IP geolocation fallback disabled by config");
      return config.defaultLocation;
    }

    try {
      const ipResponse = await axios.get('https://ipapi.co/json/', { 
        timeout: 2000,
        headers: {
          "User-Agent": `AirQualityApp/${APP_VERSION} (Render)`
        }
      });
      return { 
        lat: ipResponse.data.latitude,
        lon: ipResponse.data.longitude
      };
    } catch (error) {
      console.error("IP geolocation failed:", error);
      return config.defaultLocation;
    }
  }
}

// Server Startup
new AirQualityApp().getExpressApp().listen(PORT, () => {
  console.log(`✅ Air Quality v${APP_VERSION} running on port ${PORT}`);
  console.log(`Trust proxy setting: ${process.env.TRUST_PROXY ? 'enabled' : 'disabled'}`);
});