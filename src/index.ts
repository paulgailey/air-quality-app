// src/index.ts v1.5.7 (Integrated onLocation air quality reporting)
import 'dotenv/config';
import express from 'express';
import path from 'path';
import { TpaServer, TpaSession, ViewType } from '@augmentos/sdk';
import crypto from 'crypto';
import axios from 'axios';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import geoLocationMiddleware from './middleware/geoLocationMiddleware';

// Enhanced Type Augmentations
declare module '@augmentos/sdk' {
  interface TpaSession {
    location?: {
      latitude: number;
      longitude: number;
    };
    lastLocationUpdate?: number;
    isWaitingForLocation?: boolean;
    requestPermission?(permission: string): Promise<void>;
  }

  interface TpaServer {
    createSession(params: {
      sessionId: string;
      userId: string;
      packageName: string;
    }): Promise<void>;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(path.join(__dirname, '../package.json'), 'utf-8')
);

const APP_VERSION = '1.5.7';
const PORT = parseInt(process.env.PORT || '3000', 10);
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'air-quality-app';
const AUGMENTOS_API_KEY = process.env.AUGMENTOS_API_KEY || '';
const AQI_TOKEN = process.env.AQI_TOKEN || '';
const ENVIRONMENT = process.env.NODE_ENV || 'production';
const MAX_RESPONSE_TIME_MS = 7000;
const LOCATION_TIMEOUT_MS = 5000;

if (!AUGMENTOS_API_KEY || !AQI_TOKEN) {
  console.error('❌ Missing required environment variables');
  process.exit(1);
}

const AQI_LEVELS = [
  { max: 50, label: "Good", emoji: "😊", advice: "Perfect for outdoor activities!" },
  { max: 100, label: "Moderate", emoji: "😐", advice: "Unusually sensitive people should reduce exertion" },
  { max: 150, label: "Unhealthy for Sensitive", emoji: "😷", advice: "Sensitive groups should limit outdoor exertion" },
  { max: 200, label: "Unhealthy", emoji: "😨", advice: "Everyone should limit outdoor exertion" },
  { max: 300, label: "Very Unhealthy", emoji: "🤢", advice: "Avoid outdoor activities" },
  { max: 500, label: "Hazardous", emoji: "☠️", advice: "Stay indoors with windows closed" }
];

interface AQIStationData {
  aqi: number;
  station: {
    name: string;
    distance: number;
    geo: [number, number];
  };
}

class AirQualityApp extends TpaServer {
  private requestCount = 0;
  private readonly VOICE_COMMANDS = [
    "what's the air quality like",
    "air quality",
    "how's the air",
    "pollution level",
    "is the air safe"
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

  private async initTpaSession(params: {
    sessionId: string;
    userId: string;
    packageName: string;
  }): Promise<void> {
    await this.createSession(params);
  }

  private setupRoutes(): void {
    const app = this.getExpressApp();

    app.use(geoLocationMiddleware);

    app.use((req, res, next) => {
      this.requestCount++;
      const requestId = crypto.randomUUID();
      res.set('X-Request-ID', requestId);
      console.log(`[${new Date().toISOString()}] REQ#${this.requestCount} ${req.method} ${req.path}`);
      next();
    });

    app.use(express.json());

    app.get('/tpa_config.json', (req, res) => {
      res.json({
        voiceCommands: this.VOICE_COMMANDS.map(phrase => ({
          phrase,
          description: "Get current air quality information"
        })),
        permissions: ["location"],
        transcriptionLanguages: ["en-US"],
        requires: ["location"],
        timeoutMs: MAX_RESPONSE_TIME_MS
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
    console.log(`🚀 Session started for ${userId}`);

    const voiceHandler = async (transcript: { text: string }) => {
      const text = transcript.text.toLowerCase();
      if (!this.VOICE_COMMANDS.some(cmd => text.includes(cmd.toLowerCase()))) return;

      console.log(`🎤 Voice trigger: "${text}"`);
      await this.showListeningState(session);
      await this.processAirQualityRequest(session);
    };

    // Location handler (automatically triggered)
    session.events.onLocation(async (coords) => {
      console.log(`📍 Using coordinates: ${coords.lat}, ${coords.lon}`);
      try {
        const station = await this.getNearestAQIStation(coords.lat, coords.lon);
        const quality = AQI_LEVELS.find(l => station.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];

        await session.layouts.showTextWall(
          `📍 ${station.station.name}\n\n` +
          `Air Quality: ${quality.label} ${quality.emoji}\n` +
          `AQI: ${station.aqi}\n\n` +
          `${quality.advice}`,
          { view: ViewType.MAIN, durationMs: 10000 }
        );
      } catch (err) {
        console.error('❌ Failed during location event:', err);
        await this.showErrorState(session, 'Unable to fetch AQI data for your location.');
      }
    });

    session.onTranscriptionForLanguage('en-US', voiceHandler);

    // Defensive permission check
    if (!this.isValidLocation(session.location)) {
      try {
        if (session.requestPermission) {
          await session.requestPermission('location');
        } else {
          console.warn('requestPermission method not available on session');
        }
      } catch (error) {
        console.error('Permission error:', error);
      }
    }
  }

  private async processAirQualityRequest(session: TpaSession): Promise<void> {
    await this.showProcessingState(session);

    try {
      if (!this.isValidLocation(session.location)) {
        await session.layouts.showTextWall("📍 Locating...", { view: ViewType.MAIN, durationMs: 2000 });
        return;
      }

      const { latitude, longitude } = session.location!;
      const station = await this.getNearestAQIStation(latitude, longitude);
      const quality = AQI_LEVELS.find(l => station.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];

      await this.showAirQualityResult(session, station, quality);
    } catch (error) {
      console.error('Air quality check failed:', error);
      await this.showErrorState(session, error instanceof Error ? error.message : 'Unknown error');
    }
  }

  private async showAirQualityResult(
    session: TpaSession,
    station: AQIStationData,
    quality: typeof AQI_LEVELS[number]
  ): Promise<void> {
    await session.layouts.showTextWall(
      `📍 ${station.station.name}\n\n` +
      `Air Quality: ${quality.label} ${quality.emoji}\n` +
      `AQI: ${station.aqi}\n\n` +
      `${quality.advice}`,
      { view: ViewType.MAIN, durationMs: 10000 }
    );
  }

  private async showProcessingState(session: TpaSession): Promise<void> {
    await session.layouts.showTextWall("🔍 Checking air quality...", {
      view: ViewType.MAIN,
      durationMs: 1500
    });
  }

  private async showListeningState(session: TpaSession): Promise<void> {
    await session.layouts.showTextWall("👂 Listening...", {
      view: ViewType.MAIN,
      durationMs: 1500
    });
  }

  private async showErrorState(session: TpaSession, message: string): Promise<void> {
    await session.layouts.showTextWall(`⚠️ ${message}`, {
      view: ViewType.MAIN,
      durationMs: 5000
    });
  }

  private async getNearestAQIStation(lat: number, lon: number): Promise<AQIStationData> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    try {
      const response = await axios.get(
        `https://api.waqi.info/feed/geo:${lat};${lon}/?token=${AQI_TOKEN}`,
        { signal: controller.signal, timeout: 3000 }
      );

      if (response.data.status !== 'ok') {
        throw new Error(response.data.data || 'AQI API error');
      }

      const station = response.data.data;
      const distance = this.calculateDistance(lat, lon, station.city.geo[0], station.city.geo[1]);

      return {
        aqi: station.aqi,
        station: {
          name: station.city.name || 'Nearest Station',
          distance,
          geo: station.city.geo || [lat, lon]
        }
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) *
              Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private isValidLocation(location?: { latitude: number; longitude: number }): boolean {
    return !!location &&
      typeof location.latitude === 'number' &&
      typeof location.longitude === 'number' &&
      Math.abs(location.latitude) <= 90 &&
      Math.abs(location.longitude) <= 180 &&
      !(location.latitude === 0 && location.longitude === 0);
  }
}

new AirQualityApp();
