// debug version Claude production Railway
import * as dotenv from 'dotenv';
dotenv.config();
import path from 'path';
import { TpaServer, TpaSession, ViewType } from '@augmentos/sdk';
import { fileURLToPath } from 'url';
import { AQI_LEVELS, LocationUpdate } from './types/types.js';
import { getNearestAQIStation } from './services/airQualityService.js';
import express from 'express';
import crypto from 'crypto';

// Configuration
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);
const AUGMENTOS_API_KEY = process.env.AUGMENTOS_API_KEY || '';
const AQI_TOKEN = process.env.AQI_TOKEN || '';
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'air-quality-app';

// Debug logging
console.log('Environment check:', {
  PORT: PORT,
  API_KEY: AUGMENTOS_API_KEY ? 'SET (redacted)' : 'NOT SET',
  AQI_TOKEN: AQI_TOKEN ? 'SET (redacted)' : 'NOT SET',
  PACKAGE_NAME: PACKAGE_NAME
});

// Type extensions
declare module '@augmentos/sdk' {
  interface TpaServer {
    getExpressApp(): express.Application;
    use: express.Application['use'];
  }

  interface TpaSession {
    location?: {
      latitude: number;
      longitude: number;
      timestamp: number;
    };
    requestLocation?(): Promise<void>;
  }
}

class AirQualityApp extends TpaServer {
  private readonly VOICE_COMMANDS = [
    "what's the air quality like",
    "air quality",
    "how's the air",
    "pollution level",
    "is the air safe"
  ] as const;
  private requestCount = 0;

  constructor() {
    super({
      packageName: PACKAGE_NAME,
      apiKey: AUGMENTOS_API_KEY,
      port: PORT,
      publicDir: path.join(__dirname, 'public') // Changed from '../public'
    });

    this.setupRoutes();
    console.log(`Starting AirQualityApp on port ${PORT}`);
  }

  private setupRoutes(): void {
    const app = this.getExpressApp();
    
    app.use((req, res, next) => {
      this.requestCount++;
      const requestId = crypto.randomUUID();
      res.set('X-Request-ID', requestId);
      console.log(`[${new Date().toISOString()}] REQ#${this.requestCount} ${req.method} ${req.path}`);
      
      // Debug request body for voice commands
      if (req.method === 'POST' && req.path === '/webhook') {
        console.log('Webhook request body:', JSON.stringify(req.body));
      }
      
      next();
    });

    app.get('/', (req, res) => {
      res.json({
        status: "running",
        version: "1.0.0",
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
    
    // Add webhook debug endpoint
    app.post('/webhook-debug', (req, res) => {
      console.log('Debug webhook received:', req.body);
      res.json({ received: true, body: req.body });
    });
  }

  protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    console.log(`New session started: ${sessionId} for user ${userId}`);

    session.events.onLocation(async (update: unknown) => {
      console.log('Location update received:', update);
      const coords = update as LocationUpdate;
      const lat = coords.lat ?? coords.latitude;
      const lon = coords.lon ?? coords.longitude;

      if (lat && lon) {
        console.log(`Valid location received: ${lat}, ${lon}`);
        await this.handleLocationUpdate(session, lat, lon);
      } else {
        console.warn('Invalid location data:', update);
      }
    });

    session.events.onTranscription(async (transcript: { text: string }) => {
      console.log('Transcription received:', transcript);
      const text = transcript.text.toLowerCase();
      if (this.VOICE_COMMANDS.some(cmd => text.includes(cmd))) {
        console.log('Voice command matched:', text);
        
        if (session.location) {
          console.log('Using existing location:', session.location);
          await this.handleLocationUpdate(session, session.location.latitude, session.location.longitude);
        } else {
          console.log('No location available, requesting...');
          await session.layouts.showTextWall(
            "📍 Waiting for your location...",
            { view: ViewType.MAIN, durationMs: 8000 } // Increased from 3000ms
          );
          
          try {
            console.log('Requesting location...');
            await session.requestLocation?.();
            console.log('Location request sent');
          } catch (error) {
            console.error('Error requesting location:', error);
            await session.layouts.showTextWall(
              "⚠️ Failed to get your location. Please try again.",
              { view: ViewType.MAIN, durationMs: 5000 }
            );
          }
        }
      }
    });
  }

  private async handleLocationUpdate(session: TpaSession, lat: number, lon: number): Promise<void> {
    try {
      console.log(`Processing AQI data for location: ${lat}, ${lon} using token: ${AQI_TOKEN ? 'PRESENT' : 'MISSING'}`);
      const station = await getNearestAQIStation(lat, lon);
      console.log('AQI station data:', station);
      
      const quality = AQI_LEVELS.find(l => station.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];

      await session.layouts.showTextWall(
        `📍 ${station.station.name}\n\n` +
        `Air Quality: ${quality.label} ${quality.emoji}\n` +
        `AQI: ${station.aqi}\n\n` +
        `${quality.advice}`,
        { view: ViewType.MAIN, durationMs: 10000 }
      );
    } catch (error) {
      console.error('AQI processing error:', error);
      await session.layouts.showTextWall(
        `⚠️ Couldn't determine air quality: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { view: ViewType.MAIN, durationMs: 6000 }
      );
    }
  }
}

// Start the server
const app = new AirQualityApp();
app.getExpressApp().listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});