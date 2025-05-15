import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { TpaServer, TpaSession, ViewType } from '@augmentos/sdk';
import axios from 'axios';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import type { Request, Response, NextFunction } from 'express';

// Setup for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const packageJson = JSON.parse(
  readFileSync(path.join(__dirname, '../package.json'), 'utf-8')
);
const APP_VERSION = packageJson.version;
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'air-quality-app';
const AUGMENTOS_API_KEY = process.env.AUGMENTOS_API_KEY;
const AQI_TOKEN = process.env.AQI_TOKEN;

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

class AirQualityApp extends TpaServer {
  private activeSessions = new Map<string, { userId: string; started: Date }>();
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
      packageName: PACKAGE_NAME,
      apiKey: AUGMENTOS_API_KEY,
      port: PORT,
      publicDir: path.join(__dirname, '../public'),
    });
    
    const app = this.app;
    
    // Middleware
    app.use((req: Request, res: Response, next: NextFunction) => {
      this.requestCount++;
      const requestId = crypto.randomUUID();
      res.set('X-Request-ID', requestId);
      console.log(`[${new Date().toISOString()}] REQ#${this.requestCount} ${req.method} ${req.path}`);
      next();
    });
    app.use(express.json());

    // Routes
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
        sessions: this.activeSessions.size,
        uptime: process.uptime()
      });
    });

    app.get('/tpa_config.json', (req: Request, res: Response) => {
      res.json({
        voiceCommands: this.VOICE_COMMANDS.map(phrase => ({
          phrase,
          description: "Check air quality"
        })),
        permissions: ["location"],
        transcriptionLanguages: ["en-US"]
      });
    });

    app.post('/webhook', async (req: Request, res: Response) => {
      if (req.body?.type === 'session_request') {
        try {
          await this.createSession({
            sessionId: req.body.sessionId,
            userId: req.body.userId,
            packageName: PACKAGE_NAME
          });
          res.json({ status: 'success' });
        } catch (error) {
          console.error('Session init failed:', error);
          res.status(500).json({ status: 'error', message: 'Failed to initialize session' });
        }
      } else {
        res.status(400).json({ status: 'error', message: 'Invalid request type' });
      }
    });
    
    console.log(`🚀 AirQuality App initializing with package: ${PACKAGE_NAME}`);
  }

  protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    this.activeSessions.set(sessionId, { userId, started: new Date() });
    console.log(`🔌 Session started: ${sessionId} for user ${userId}`);

    session.onTranscriptionForLanguage('en-US', (transcript: any) => {
      const text = transcript.text.toLowerCase();
      console.log(`🎤 Heard: "${text}"`);
      if (this.VOICE_COMMANDS.some(cmd => text.includes(cmd.toLowerCase()))) {
        this.checkAirQuality(session).catch(console.error);
      }
    });

    session.onDisconnect(() => {
      console.log(`🔌 Session disconnected: ${sessionId}`);
      this.activeSessions.delete(sessionId);
    });

    await this.checkAirQuality(session);
  }

  private async getNearestAQIStation(lat: number, lon: number): Promise<AQIStationData> {
    try {
      console.log(`🔍 Fetching AQI data for coordinates: ${lat}, ${lon}`);
      const response = await axios.get(
        `https://api.waqi.info/feed/geo:${lat};${lon}/?token=${AQI_TOKEN}`,
        { timeout: 5000 }
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
      console.error('❌ AQI station fetch failed:', error);
      throw error;
    }
  }

  private async checkAirQuality(session: TpaSession): Promise<void> {
    try {
      // Get location either from session or approximate by IP
      const coords = session.location?.latitude 
        ? { lat: session.location.latitude, lon: session.location.longitude }
        : await this.getApproximateCoords();
      
      console.log(`📍 Using coordinates: ${coords.lat}, ${coords.lon}`);
      
      const station = await this.getNearestAQIStation(coords.lat, coords.lon);
      const quality = AQI_LEVELS.find(l => station.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];
      
      console.log(`💨 AQI: ${station.aqi} (${quality.label}) at ${station.station.name}`);
      
      await session.layouts.showTextWall(
        `📍 ${station.station.name}\n\n` +
        `Air Quality: ${quality.label} ${quality.emoji}\n` +
        `AQI: ${station.aqi}\n\n` +
        `${quality.advice}`,
        { view: ViewType.MAIN, durationMs: 10000 }
      );
    } catch (error) {
      console.error("❌ AQI check failed:", error);
      await session.layouts.showTextWall("Air quality unavailable", { 
        view: ViewType.MAIN,
        durationMs: 3000 
      });
    }
  }

  private async getApproximateCoords(): Promise<{ lat: number, lon: number }> {
    try {
      console.log('📱 User location not available. Attempting IP geolocation...');
      const ip = await axios.get('https://ipapi.co/json/', { timeout: 3000 });
      if (ip.data.latitude && ip.data.longitude) {
        console.log(`📍 IP geolocation success: ${ip.data.latitude}, ${ip.data.longitude}`);
        return { lat: ip.data.latitude, lon: ip.data.longitude };
      }
    } catch (error) {
      console.warn("⚠️ IP geolocation failed:", error);
    }
    console.log('📍 Using London as fallback location');
    return { lat: 51.5074, lon: -0.1278 }; // London fallback
  }
}

// Server Startup
const airQualityApp = new AirQualityApp();
const expressApp = airQualityApp.app;

expressApp.listen(PORT, () => {
  console.log(`✅ Air Quality v${APP_VERSION} running on port ${PORT}`);
  console.log(`🌐 Server is listening at http://localhost:${PORT}`);
});