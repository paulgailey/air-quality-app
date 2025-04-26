// ======================
// AIR QUALITY APP v1.1.0 (2024-06-20)
// COMPLETE PRODUCTION CODE
// FEATURES:
// 1. Station-based location reporting
// 2. Intelligent voice command handling
// 3. Automatic transcription pausing
// ======================

import 'dotenv/config';
import express from 'express';
import path from 'path';
import { TpaServer, TpaSession, ViewType, StreamType } from '@augmentos/sdk';
import axios from 'axios';
import crypto from 'crypto';
import { readFileSync } from 'fs';

// ======================
// CONFIGURATION (20 lines)
// ======================
const packageJson = JSON.parse(readFileSync(path.join(__dirname, '../package.json'), 'utf-8'));
const APP_VERSION = '1.1.0';
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'com.everywoah.airquality';
const AUGMENTOS_API_KEY = process.env.AUGMENTOS_API_KEY;
const AQI_TOKEN = process.env.AQI_TOKEN;

if (!AUGMENTOS_API_KEY || !AQI_TOKEN) {
  console.error('❌ Missing required environment variables');
  process.exit(1);
}

// ======================
// AQI STANDARDS (15 lines)
// ======================
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

// ======================
// CORE APPLICATION (240 lines)
// ======================
class AirQualityApp extends TpaServer {
  private activeSessions = new Map<string, { userId: string; started: Date }>();
  private activeTranscriptions = new Map<string, boolean>();
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
      res.json({
        status: "healthy",
        sessions: this.activeSessions.size,
        uptime: process.uptime()
      });
    });

    app.get('/tpa_config.json', (req, res) => {
      res.json({
        voiceCommands: this.VOICE_COMMANDS.map(phrase => ({
          phrase,
          description: "Check air quality"
        })),
        permissions: ["location"],
        transcriptionLanguages: ["en-US"],
        streamAccess: [StreamType.TRANSCRIPTION]
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
    this.activeSessions.set(sessionId, { userId, started: new Date() });
    this.activeTranscriptions.set(sessionId, true);

    const cleanup = session.onTranscriptionForLanguage('en-US', (transcript) => {
      if (!this.activeTranscriptions.get(sessionId)) return;

      const text = transcript.text.toLowerCase();
      if (this.VOICE_COMMANDS.some(cmd => text.includes(cmd.toLowerCase()))) {
        console.log(`✅ Command processed: "${text}" (Session: ${sessionId})`);
        this.activeTranscriptions.set(sessionId, false);
        this.checkAirQuality(session)
          .catch(console.error)
          .finally(() => {
            this.activeTranscriptions.set(sessionId, true);
            console.log(`♻️ Ready for next command (Session: ${sessionId})`);
          });
      }
    });

    await this.checkAirQuality(session);
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
        name: response.data.data.city?.name || 'Nearest AQI Station',
        geo: response.data.data.city?.geo || [lat, lon]
      }
    };
  }

  private async checkAirQuality(session: TpaSession): Promise<void> {
    try {
      const coords = session.location?.latitude 
        ? { lat: session.location.latitude, lon: session.location.longitude }
        : await this.getApproximateCoords();

      const { aqi, station } = await this.getNearestAQIStation(coords.lat, coords.lon);
      const quality = AQI_LEVELS.find(l => aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];
      
      await session.layouts.showTextWall(
        `📍 ${station.name}\n\n` +
        `Air Quality: ${quality.label} ${quality.emoji}\n` +
        `AQI: ${aqi}\n\n` +
        `${quality.advice}`,
        { view: ViewType.MAIN, durationMs: 10000 }
      );
    } catch (error) {
      console.error("AQI check failed:", error);
      await session.layouts.showTextWall("Air quality data unavailable", { 
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
    return { lat: 51.5074, lon: -0.1278 };
  }
}

// ======================
// SERVER INITIALIZATION
// ======================
new AirQualityApp().getExpressApp().listen(PORT, () => {
  console.log(`✅ Air Quality v${APP_VERSION} running on port ${PORT}`);
});