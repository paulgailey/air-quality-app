// src/index.ts v1.5.1
import 'dotenv/config';
import express from 'express';
import path from 'path';
import { TpaServer, TpaSession, ViewType } from '@augmentos/sdk';
import crypto from 'crypto';
import axios from 'axios';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

// Augment the Augmentos SDK types
declare module '@augmentos/sdk' {
  interface TpaSession {
    location?: {
      latitude: number;
      longitude: number;
    };
    lastLocationUpdate?: number;
  }

  // Define the LocationUpdate interface
  interface LocationUpdate {
    latitude: number;
    longitude: number;
    accuracy?: number;
    timestamp?: number;
  }

  // Define the Handler type for events
  type Handler<T> = (payload: T) => void;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(path.join(__dirname, '../package.json'), 'utf-8')
);

const APP_VERSION = '1.5.1';
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
  }

  protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    console.log(`🚀 Session started for ${userId}`);
    await this.showListeningState(session, true);

    const handlers = {
      active: true,
      location: (update: { latitude: number; longitude: number }) => {
        if (!handlers.active) return;
        session.location = {
          latitude: update.latitude,
          longitude: update.longitude
        };
        session.lastLocationUpdate = Date.now();
        console.log(`📍 Location updated: ${update.latitude}, ${update.longitude}`);
      },
      voice: async (transcript: { text: string }) => {
        if (!handlers.active) return;
        const text = transcript.text.toLowerCase();
        if (!this.VOICE_COMMANDS.some(cmd => text.includes(cmd.toLowerCase()))) return;

        console.log(`🎤 Processing: "${text}"`);
        await this.showProcessingState(session);
        
        try {
          await this.handleAirQualityRequest(session);
        } finally {
          await this.showListeningState(session, true);
        }
      }
    };

    session.events.onLocation(handlers.location);
    session.onTranscriptionForLanguage('en-US', handlers.voice);
    session.events.onDisconnected(() => {
      handlers.active = false;
      console.log(`🛑 Session ended for ${userId}`);
    });

    if (session.location) {
      session.lastLocationUpdate = Date.now();
    }
  }

  private async showListeningState(session: TpaSession, isListening: boolean): Promise<void> {
    await session.layouts.showTextWall(
      isListening ? "👂 Listening... Say 'air quality'" : "",
      { view: ViewType.MAIN, durationMs: 5000 }
    );
  }

  private async showProcessingState(session: TpaSession): Promise<void> {
    await session.layouts.showTextWall(
      "🔄 Getting your air quality...",
      { view: ViewType.MAIN, durationMs: 2000 }
    );
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
        throw new Error('Invalid AQI API response');
      }

      const distance = this.calculateDistance(
        lat, lon,
        response.data.data.city?.geo?.[0] || lat,
        response.data.data.city?.geo?.[1] || lon
      );

      return {
        aqi: response.data.data.aqi,
        station: {
          name: response.data.data.city?.name || 'Nearest Station',
          distance,
          geo: response.data.data.city?.geo || [lat, lon]
        }
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  private async handleAirQualityRequest(session: TpaSession): Promise<void> {
    const startTime = Date.now();
    
    try {
      if (!session.location || !session.lastLocationUpdate || 
          Date.now() - session.lastLocationUpdate > LOCATION_TIMEOUT_MS) {
        throw new Error('Location not available or outdated');
      }

      const { latitude, longitude } = session.location;
      const station = await this.getNearestAQIStation(latitude, longitude);
      const quality = AQI_LEVELS.find(l => station.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];

      const remainingTime = MAX_RESPONSE_TIME_MS - (Date.now() - startTime);
      const displayTime = Math.max(remainingTime, 3000);

      await session.layouts.showTextWall(
        `📍 ${station.station.name} (${station.station.distance.toFixed(1)}km)\n\n` +
        `Air Quality Index: ${station.aqi} ${quality.emoji}\n` +
        `Status: ${quality.label}\n\n` +
        `Recommendation: ${quality.advice}`,
        { view: ViewType.MAIN, durationMs: displayTime }
      );
    } catch (error) {
      console.error('Air quality check failed:', error);
      const remainingTime = MAX_RESPONSE_TIME_MS - (Date.now() - startTime);
      const displayTime = Math.max(remainingTime, 3000);

      await session.layouts.showTextWall(
        "⚠️ Couldn't get air quality data. Please try again.",
        { view: ViewType.MAIN, durationMs: displayTime }
      );
    }
  }
}

new AirQualityApp().getExpressApp().listen(PORT, () => {
  console.log(`✅ Air Quality v${APP_VERSION} running on port ${PORT} in ${ENVIRONMENT} mode`);
});