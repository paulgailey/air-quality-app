// src/index.ts v1.3.4
import 'dotenv/config';
import express from 'express';
import path from 'path';
import { TpaServer, TpaSession, ViewType } from '@augmentos/sdk';
import crypto from 'crypto';
import axios from 'axios';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

// Extend TpaSession with optional location property
declare module '@augmentos/sdk' {
  interface TpaSession {
    location?: {
      latitude: number;
      longitude: number;
    };
  }

  interface TpaServer {
    initTpaSession(params: {
      sessionId: string;
      userId: string;
      packageName: string;
    }): Promise<void>;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(path.join(__dirname, '../package.json'), 'utf-8'));

const APP_VERSION = '1.3.4';
const PORT = parseInt(process.env.PORT || '3000', 10);
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'air-quality-app';
const AUGMENTOS_API_KEY = process.env.AUGMENTOS_API_KEY || '';
const AQI_TOKEN = process.env.AQI_TOKEN || '';

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
  locationSource: string;
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
        endpoints: ['/health', '/tpa_config.json']
      });
    });

    app.get('/health', (req, res) => {
      res.json({ status: "healthy" });
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
          await this.initTpaSession({
            sessionId: req.body.sessionId,
            userId: req.body.userId,
            packageName: PACKAGE_NAME
          });
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

  protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    session.onTranscriptionForLanguage('en-US', (transcript) => {
      const text = transcript.text.toLowerCase();
      console.log(`🎤 Heard: "${text}"`);
      if (this.VOICE_COMMANDS.some(cmd => text.includes(cmd.toLowerCase()))) {
        this.checkAirQuality(session).catch(console.error);
      }
    });

    await this.checkAirQuality(session);
  }

  private async getNearestAQIStation(lat: number, lon: number, locationSource: string): Promise<AQIStationData> {
    try {
      const response = await axios.get(`https://api.waqi.info/feed/geo:${lat};${lon}/?token=${AQI_TOKEN}`, {
        timeout: 3000,
        headers: { 'Accept-Encoding': 'gzip, deflate' }
      });

      if (response.data.status !== 'ok') {
        throw new Error('Station data unavailable');
      }

      return {
        aqi: response.data.data.aqi,
        station: {
          name: response.data.data.city?.name || 'Nearest AQI station',
          geo: response.data.data.city?.geo || [lat, lon]
        },
        locationSource
      };
    } catch (error) {
      console.error('AQI station fetch failed:', error);
      throw error;
    }
  }

  private async checkAirQuality(session: TpaSession): Promise<void> {
    try {
      let coords, locationSource: string;

      if (session.location) {
        coords = { lat: session.location.latitude, lon: session.location.longitude };
        locationSource = '📡 Using device GPS location';
      } else {
        try {
          const ipGeo = await axios.get('https://ipapi.co/json/', {
            timeout: 2000,
            headers: { 'Accept-Encoding': 'gzip, deflate' }
          });

          if (ipGeo.data.latitude && ipGeo.data.longitude) {
            coords = { lat: ipGeo.data.latitude, lon: ipGeo.data.longitude };
            locationSource = '🌐 Using IP-based location';
          } else {
            throw new Error();
          }
        } catch {
          coords = { lat: 51.5074, lon: -0.1278 }; // London
          locationSource = '🌍 Location unknown – using default';
        }
      }

      const station = await this.getNearestAQIStation(coords.lat, coords.lon, locationSource);
      const quality = AQI_LEVELS.find(l => station.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];

      await session.layouts.showTextWall(
        `📍 ${station.station.name}\n(${station.locationSource})\n\n` +
        `AQI: ${station.aqi} – ${quality.label} ${quality.emoji}\n` +
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
}

new AirQualityApp().getExpressApp().listen(PORT, () => {
  console.log(`✅ Air Quality v${APP_VERSION} running on port ${PORT}`);
});
