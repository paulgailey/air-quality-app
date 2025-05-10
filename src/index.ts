// Version 2.1.2 - Proper base class extension
import 'dotenv/config';
import express, { Request, Response, NextFunction, Application } from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { TpaServer, TpaSession, ViewType } from '@augmentos/sdk';
import axios from 'axios';
import crypto from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { ParsedQs } from 'qs';

// Configuration
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(path.join(__dirname, '../package.json'), 'utf-8')
);
const config = JSON.parse(readFileSync(path.join(__dirname, '../config.json'), 'utf-8'));
const APP_VERSION = "2.1.2";
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
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

interface SessionData {
  lastActive: number;
  location?: {
    lat: number;
    lon: number;
  };
}

declare module '@augmentos/sdk' {
  interface TpaSession {
    audio?: {
      play(path: string): Promise<void>;
      speak?(text: string, options?: { language?: string }): Promise<void>;
    };
    onLocation(
      listener: (update: {
        coords: {
          latitude: number;
          longitude: number;
          accuracy: number;
          altitude: number | null;
          altitudeAccuracy: number | null;
          heading: number | null;
          speed: number | null;
        };
        timestamp: number;
      }) => void
    ): void;
  }
}

class AirQualityApp extends TpaServer {
  private requestCount = 0;
  private readonly VOICE_COMMANDS = [
    "air quality",
    "what's the air like",
    "pollution",
    "how clean is the air",
    "is the air safe",
    "nearest air quality station"
  ];
  private sessionDataMap = new Map<string, SessionData>(); // Renamed to avoid conflict

  constructor() {
    super({
      packageName: "air-quality-app",
      apiKey: AUGMENTOS_API_KEY,
      port: PORT,
      publicDir: path.join(__dirname, '../public'),
    });
    this.setupRoutes();
  }

  private setupRoutes(): void {
    const app = this.getExpressApp() as Application;

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
        sessions: this.sessionDataMap.size,
        endpoints: ['/health', '/tpa_config.json']
      });
    });

    app.get('/health', (req: Request, res: Response) => {
      res.json({
        status: "healthy",
        sessions: this.sessionDataMap.size
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
    console.log(`Initializing session ${sessionId} for ${userId}`);
    this.sessionDataMap.set(sessionId, { lastActive: Date.now() });
  }

  protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    const sessionData: SessionData = { lastActive: Date.now() };
    this.sessionDataMap.set(sessionId, sessionData);

    session.onLocation((update) => {
      sessionData.lastActive = Date.now();
      sessionData.location = {
        lat: update.coords.latitude,
        lon: update.coords.longitude
      };
    });

    session.onTranscriptionForLanguage('en-US', (transcript) => {
      sessionData.lastActive = Date.now();
      const text = transcript.text.toLowerCase();
      if (this.VOICE_COMMANDS.some(cmd => text.includes(cmd.toLowerCase()))) {
        this.checkAirQuality(session, sessionData.location).catch(console.error);
      }
    });

    await this.checkAirQuality(session, sessionData.location);
  }

  private async checkAirQuality(
    session: TpaSession,
    coords?: { lat: number; lon: number }
  ): Promise<void> {
    try {
      const finalCoords = coords || await this.getApproximateCoords();
      const station = await this.getNearestAQIStation(finalCoords.lat, finalCoords.lon);
      const quality = AQI_LEVELS.find(l => station.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];
      
      await (session.layouts as any).showTextWall(
        `📍 ${station.station.name}\n\n` +
        `Air Quality: ${quality.label} ${quality.emoji}\n` +
        `AQI: ${station.aqi}\n\n` +
        `${quality.advice}`,
        { view: ViewType.MAIN, durationMs: 10000 }
      );

      await this.playAudioForQuality(session, quality.label);
    } catch (error) {
      console.error("Air quality check failed:", error);
      await (session.layouts as any).showTextWall("Air quality unavailable", { 
        view: ViewType.MAIN,
        durationMs: 3000 
      });
    }
  }

  private async playAudioForQuality(session: TpaSession, qualityLabel: string): Promise<void> {
    if (!session.audio?.play) return;

    const audioBasePath = path.join(__dirname, '../public/audio/blip');
    const aqiLevel = qualityLabel.toLowerCase().split(' ')[0];
    const audioFiles = [
      path.join(audioBasePath, `${aqiLevel}.mp3`),
      path.join(audioBasePath, 'default.mp3')
    ];

    for (const audioFile of audioFiles) {
      if (existsSync(audioFile)) {
        try {
          await session.audio.play(audioFile);
          break;
        } catch (error) {
          console.error('Audio playback failed:', error);
        }
      }
    }
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

  private async getApproximateCoords(): Promise<{ lat: number, lon: number }> {
    try {
      const ip = await axios.get('https://ipapi.co/json/', { timeout: 2000 });
      if (ip.data.latitude && ip.data.longitude) {
        return { lat: ip.data.latitude, lon: ip.data.longitude };
      }
    } catch (error) {
      console.warn("IP geolocation failed - using config default:", error);
    }
    return config.defaultLocation;
  }
}

// Server Startup
new AirQualityApp().getExpressApp().listen(PORT, () => {
  console.log(`✅ Air Quality v${APP_VERSION} running on port ${PORT}`);
  console.log(`Configure ngrok with: ngrok http ${PORT}`);
}).on('error', (err: Error) => {
  console.error('Server error:', err);
  process.exit(1);
});