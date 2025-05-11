// Air Quality App v2.0.8 - Production Ready (Zero TS Errors)
import * as dotenv from 'dotenv';
dotenv.config();
import express, { Request, Response, NextFunction } from 'express';
import * as path from 'path';
import { TpaSession } from '@augmentos/sdk';
import axios from 'axios';
import crypto from 'crypto';
import { readFileSync, existsSync } from 'fs';

// Configuration
const __dirname = process.cwd();
const config = JSON.parse(readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
const APP_VERSION = "2.0.8";
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Strict Environment Validation
const AUGMENTOS_API_KEY = process.env.AUGMENTOS_API_KEY;
const AQI_TOKEN = process.env.AQI_TOKEN;

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
] as const;

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

// AugmentOS SDK Extensions
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
    layouts?: {
      showTextWall?(text: string, options: { view: string; durationMs: number }): Promise<void>;
    };
    onLocation?(callback: (update: LocationUpdate) => void): void;
  }
}

class AirQualityApp {
  private app = express();
  private sessionMap = new Map<string, { userId: string; started: Date }>();
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
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Render-specific config
    this.app.set('trust proxy', process.env.TRUST_PROXY ? 1 : false);

    // Fixed middleware declaration
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type,Authorization');
      res.setHeader('ngrok-skip-browser-warning', 'true');
      
      console.log(`${new Date().toISOString()} - ${req.method} ${req.path} from ${req.ip}`);
      
      next();
    });

    // Options handler moved to separate route
    this.app.options('*', (req: Request, res: Response) => {
      res.sendStatus(200);
    });

    this.app.use((req: Request, res: Response, next: NextFunction) => {
      this.requestCount++;
      res.set('X-Request-ID', crypto.randomUUID());
      next();
    });

    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, 'public')));

    // Routes
    this.app.get('/', (req: Request, res: Response) => {
      res.json({
        status: "running",
        version: APP_VERSION,
        sessions: this.sessionMap.size
      });
    });

    this.app.get('/health', (req: Request, res: Response) => {
      res.json({
        status: "healthy",
        trustProxy: this.app.get('trust proxy')
      });
    });
  }

  public async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    this.sessionMap.set(sessionId, { userId, started: new Date() });

    if (session.onLocation) {
      session.onLocation((update) => {
        this.checkAirQuality(session, {
          lat: update.coords.latitude,
          lon: update.coords.longitude
        }).catch(console.error);
      });
    }

    await this.checkAirQuality(session, await this.getApproximateCoords());
  }

  private async checkAirQuality(
    session: TpaSession,
    coords: { lat: number; lon: number }
  ): Promise<void> {
    try {
      const station = await this.getNearestAQIStation(coords.lat, coords.lon);
      const quality = AQI_LEVELS.find(l => station.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];
      
      if (session.layouts?.showTextWall) {
        await session.layouts.showTextWall(
          `📍 ${station.station.name}\n\n` +
          `Air Quality: ${quality.label} ${quality.emoji}\n` +
          `AQI: ${station.aqi}\n\n` +
          `${quality.advice}`,
          { view: 'main', durationMs: 10000 }
        );
      }

      if (session.audio?.play) {
        const audioPath = path.join(__dirname, 'public/audio/blip', `${quality.label.toLowerCase().split(' ')[0]}.mp3`);
        if (existsSync(audioPath)) {
          await session.audio.play(audioPath);
        }
      }
    } catch (error) {
      console.error("Air quality check failed:", error);
      if (session.layouts?.showTextWall) {
        await session.layouts.showTextWall("Service unavailable", { 
          view: 'main',
          durationMs: 3000 
        });
      }
    }
  }

  public getExpressApp(): express.Express {
    return this.app;
  }

  private async getNearestAQIStation(lat: number, lon: number): Promise<AQIStationData> {
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
        name: response.data.data.city?.name || 'Nearest station',
        geo: response.data.data.city?.geo || [lat, lon]
      }
    };
  }

  private async getApproximateCoords(): Promise<{ lat: number; lon: number }> {
    if (process.env.DISABLE_IP_GEOLOCATION_FALLBACK === "true") {
      return config.defaultLocation;
    }

    try {
      const { data } = await axios.get('https://ipapi.co/json/', { 
        timeout: 2000,
        headers: { "User-Agent": `AirQualityApp/${APP_VERSION}` }
      });
      return { lat: data.latitude, lon: data.longitude };
    } catch {
      return config.defaultLocation;
    }
  }
}

// Enhanced Server Startup
const app = new AirQualityApp();
const server = app.getExpressApp().listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Air Quality v${APP_VERSION} running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Host: ${process.env.HOST || '0.0.0.0'}`);
  console.log(`Public URL: ${process.env.RENDER_EXTERNAL_URL || 'not set'}`);
  console.log(`AQI API Key: ${AQI_TOKEN ? '✓ Present' : '✗ Missing'}`);
  console.log(`AugmentOS API Key: ${AUGMENTOS_API_KEY ? '✓ Present' : '✗ Missing'}`);
});

// Handle shutdown gracefully
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
