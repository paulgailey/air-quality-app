import 'dotenv/config';
import express from 'express';
import path from 'path';
import { TpaServer, TpaSession, ViewType, StreamType } from '@augmentos/sdk';
import axios from 'axios';
import crypto from 'crypto';
import { readFileSync } from 'fs';

// Configuration
const packageJson = JSON.parse(
  readFileSync(path.join(__dirname, '../package.json'), 'utf-8')
);

const APP_VERSION = packageJson.version;
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'com.everywoah.airquality';
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

interface ResolvedLocation {
  latitude: number;
  longitude: number;
  city: string;
  source: string;
}

class AirQualityApp extends TpaServer {
  private activeSessions = new Map<string, { userId: string; started: Date }>();
  private requestCount = 0;

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

    // Middleware
    app.use((req, res, next) => {
      this.requestCount++;
      const requestId = crypto.randomUUID();
      res.set('X-Request-ID', requestId);
      console.log(`[${new Date().toISOString()}] REQ#${this.requestCount} ${req.method} ${req.path}`);
      next();
    });

    app.use(express.json());

    // Routes
    app.get('/', (req, res) => {
      res.json({
        status: "running",
        version: APP_VERSION,
        endpoints: ['/health', '/tpa_config.json', '/webhook']
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
        voiceCommands: [
          "air quality", "what's the air like", "pollution"
        ].map(phrase => ({ phrase, description: "Check air quality" })),
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

    session.onTranscriptionForLanguage('en-US', (data) => {
      if (["air quality", "pollution"].some(cmd => data.text.toLowerCase().includes(cmd))) {
        this.checkAirQuality(session);
      }
    });

    await this.checkAirQuality(session);
  }

  private async resolveUserLocation(session: TpaSession): Promise<ResolvedLocation> {
    // 1. AugmentOS precise location (primary)
    try {
      const location = await session.getLocation();
      if (location?.latitude && location?.longitude) {
        const city = await this.reverseGeocode(location.latitude, location.longitude);
        return { ...location, city, source: "gps" };
      }
    } catch (error) {
      console.warn("AugmentOS location failed:", error);
    }

    // 2. IP geolocation (fallback)
    try {
      const ip = await axios.get('https://ipapi.co/json/', { timeout: 2000 });
      if (ip.data.latitude && ip.data.longitude) {
        const city = ip.data.city || await this.reverseGeocode(ip.data.latitude, ip.data.longitude);
        return {
          latitude: ip.data.latitude,
          longitude: ip.data.longitude,
          city,
          source: "ip"
        };
      }
    } catch (error) {
      console.warn("IP geolocation failed:", error);
    }

    // 3. Final fallback
    return {
      latitude: 51.5074,
      longitude: -0.1278,
      city: "London",
      source: "fallback"
    };
  }

  private async reverseGeocode(lat: number, lon: number): Promise<string> {
    try {
      const response = await axios.get(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`,
        { timeout: 2000 }
      );
      return response.data.address?.city || response.data.address?.town || 'Your location';
    } catch {
      return 'Your area';
    }
  }

  private async checkAirQuality(session: TpaSession): Promise<void> {
    try {
      const location = await this.resolveUserLocation(session);
      const aqiData = await this.fetchAQI(location.latitude, location.longitude);
      const quality = AQI_LEVELS.find(l => aqiData.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];
      
      await session.layouts.showTextWall(
        `📍 ${location.city} (${location.source})\n\n` +
        `Air Quality: ${quality.label} ${quality.emoji}\n` +
        `AQI: ${aqiData.aqi}\n\n` +
        `${quality.advice}`,
        { view: ViewType.MAIN, durationMs: 10000 }
      );
    } catch (error) {
      console.error("AQI check failed:", error);
      await session.layouts.showTextWall("Could not fetch air quality data", { 
        view: ViewType.MAIN,
        durationMs: 3000 
      });
    }
  }

  private async fetchAQI(lat: number, lon: number): Promise<{ aqi: number; city: { name: string } }> {
    const response = await axios.get(
      `https://api.waqi.info/feed/geo:${lat};${lon}/?token=${AQI_TOKEN}`,
      { timeout: 3000 }
    );
    
    if (response.data.status !== 'ok') {
      throw new Error(response.data.data || 'Invalid AQI response');
    }
    
    return {
      aqi: response.data.data.aqi,
      city: {
        name: response.data.data.city?.name || 'Your location'
      }
    };
  }
}

// Start server
new AirQualityApp().getExpressApp().listen(PORT, () => {
  console.log(`✅ Air Quality v${APP_VERSION} running on port ${PORT}`);
});