// src/index.ts v1.4.1
import 'dotenv/config';
import express from 'express';
import path from 'path';
import { TpaServer, TpaSession, ViewType } from '@augmentos/sdk';
import crypto from 'crypto';
import axios from 'axios';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

declare module '@augmentos/sdk' {
  interface TpaSession {
    location?: {
      latitude: number;
      longitude: number;
    };
  }

  interface LocationUpdate {
    latitude: number;
    longitude: number;
    accuracy?: number;
    timestamp?: number;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(path.join(__dirname, '../package.json'), 'utf-8')
);

const APP_VERSION = '1.4.1';
const PORT = parseInt(process.env.PORT || '3000', 10);
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'air-quality-app';
const AUGMENTOS_API_KEY = process.env.AUGMENTOS_API_KEY || '';
const AQI_TOKEN = process.env.AQI_TOKEN || '';
const ENVIRONMENT = process.env.NODE_ENV || 'production';

if (!AUGMENTOS_API_KEY || !AQI_TOKEN) {
  console.error('❌ Missing required environment variables');
  process.exit(1);
}

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
      publicDir: path.join(__dirname, '../public')
    });

    this.setupRoutes();
  }

  private setupRoutes(): void {
    const app = this.getExpressApp();

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
        environment: ENVIRONMENT,
        endpoints: ['/health', '/version', '/tpa_config.json']
      });
    });

    app.get('/health', (req, res) => {
      res.json({ status: "healthy" });
    });

    app.get('/version', (req, res) => {
      res.json({ version: APP_VERSION });
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
  }

  protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    // Subscribe to location updates with proper typing
    session.events.onLocation((locationUpdate) => {
      console.log(`📍 Received location update:`, 
        `${locationUpdate.latitude}, ${locationUpdate.longitude}` +
        (locationUpdate.accuracy ? ` (±${locationUpdate.accuracy}m)` : '')
      );
      
      session.location = {
        latitude: locationUpdate.latitude,
        longitude: locationUpdate.longitude
      };
      
      this.handleAirQualityRequest(session).catch(console.error);
    });

    // Handle voice commands
    session.onTranscriptionForLanguage('en-US', (transcript) => {
      const text = transcript.text.toLowerCase();
      console.log(`🎤 Heard: "${text}"`);
      if (this.VOICE_COMMANDS.some(cmd => text.includes(cmd.toLowerCase()))) {
        this.handleAirQualityRequest(session).catch(console.error);
      }
    });

    // Initial check if location is already available
    if (session.location) {
      await this.handleAirQualityRequest(session);
    }
  }

  private async getNearestAQIStation(lat: number, lon: number): Promise<AQIStationData> {
    try {
      const response = await axios.get(
        `https://api.waqi.info/feed/geo:${lat};${lon}/?token=${AQI_TOKEN}`,
        {
          timeout: 3000,
          headers: { 'Accept-Encoding': 'gzip, deflate' }
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
      throw new Error('Failed to fetch air quality data');
    }
  }

  private async handleAirQualityRequest(session: TpaSession): Promise<void> {
    try {
      if (!session.location) {
        await session.layouts.showTextWall(
          "Please enable location services to check air quality",
          { view: ViewType.MAIN, durationMs: 5000 }
        );
        return;
      }

      const { latitude, longitude } = session.location;
      console.log(`📍 Using device coordinates: ${latitude}, ${longitude}`);

      const station = await this.getNearestAQIStation(latitude, longitude);
      const quality = AQI_LEVELS.find(l => station.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];

      await session.layouts.showTextWall(
        `📍 ${station.station.name}\n\n` +
        `Air Quality: ${quality.label} ${quality.emoji}\n` +
        `AQI: ${station.aqi}\n\n` +
        `${quality.advice}`,
        { view: ViewType.MAIN, durationMs: 15000 }
      );
    } catch (error) {
      console.error("Air quality check failed:", error);
      await session.layouts.showTextWall(
        "Unable to fetch air quality data. Please try again later.",
        { view: ViewType.MAIN, durationMs: 5000 }
      );
    }
  }
}

new AirQualityApp().getExpressApp().listen(PORT, () => {
  console.log(`✅ Air Quality v${APP_VERSION} running on port ${PORT} in ${ENVIRONMENT} mode`);
});