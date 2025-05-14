// Version 1.4.0 - Complete rewrite with robust SDK initialization
import * as dotenv from 'dotenv';
dotenv.config();
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import crypto from 'crypto';
import fetch from 'node-fetch';
import type { RequestInit } from 'node-fetch';
import { AQI_LEVELS, LocationUpdate } from './types/types.js';
import { getNearestAQIStation } from './services/airQualityService.js';

// Define ViewType enum since it's not exported from SDK
enum ViewType {
  MAIN = 'main',
  NOTIFICATION = 'notification'
}

// Configuration
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);
const AUGMENTOS_API_KEY = process.env.AUGMENTOS_API_KEY || '';
const AQI_TOKEN = process.env.AQI_TOKEN || '';
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'air-quality-app';
const ENABLE_LOCATION_FALLBACK = process.env.ENABLE_LOCATION_FALLBACK === 'true';
const LOCATION_TIMEOUT_MS = parseInt(process.env.LOCATION_TIMEOUT_MS || '10000', 10);
const DEFAULT_LAT = parseFloat(process.env.DEFAULT_LAT || '51.5074');
const DEFAULT_LON = parseFloat(process.env.DEFAULT_LON || '-0.1278');

// Debug logging
console.log('Environment check:', {
  PORT,
  API_KEY: AUGMENTOS_API_KEY ? 'SET (redacted)' : 'NOT SET',
  AQI_TOKEN: AQI_TOKEN ? 'SET (redacted)' : 'NOT SET',
  PACKAGE_NAME,
  ENABLE_LOCATION_FALLBACK,
  LOCATION_TIMEOUT_MS,
  DEFAULT_LOCATION: `${DEFAULT_LAT},${DEFAULT_LON}`
});

// Define TpaSession interface
interface TpaSession {
  location?: {
    latitude: number;
    longitude: number;
    timestamp: number;
  };
  requestLocation(): Promise<void>;
  getLastKnownLocation(): Promise<{ lat: number; lon: number } | null>;
  hasLocationPermission(): Promise<boolean>;
  events: {
    on(event: string, handler: (data: any) => void): void;
    off?(event: string, handler: (data: any) => void): void;
  };
  layouts: {
    showTextWall(text: string, options: { view: ViewType; durationMs: number }): Promise<void>;
  };
}

// Define TpaServer interface
interface TpaServer {
  new (config: {
    packageName: string;
    apiKey: string;
    port: number;
    publicDir: string;
  }): TpaServer;
  onSession: (session: TpaSession, sessionId: string, userId: string) => Promise<void>;
}

class AirQualityApp {
  private expressServer?: ReturnType<express.Application['listen']>;
  private readonly VOICE_COMMANDS = [
    "what's the air quality like",
    "air quality",
    "how's the air",
    "pollution level",
    "is the air safe"
  ] as const;
  private requestCount = 0;
  private expressApp: express.Application;
  private tpaServer?: any;

  constructor() {
    this.expressApp = express();
    
    this.expressServer = this.expressApp.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on http://0.0.0.0:${PORT}`);
    });

    this.setupRoutes();
    console.log(`Starting AirQualityApp on port ${PORT}`);

    this.initializeSdk().catch(err => {
      console.error('SDK initialization failed:', err);
    });
  }

  private async initializeSdk(): Promise<void> {
    try {
      // Dynamic import with proper error handling
      const sdkModule = await import('@augmentos/sdk');
      
      // Debug log to inspect module structure
      console.log('SDK Module Exports:', Object.keys(sdkModule));

      // Fixed constructor approach - directly use what's imported, no accessing .default
      const TpaServerConstructor = sdkModule.TpaServer || sdkModule;
      
      if (typeof TpaServerConstructor !== 'function') {
        throw new Error('No valid constructor found in SDK exports. Available exports: ' + 
          Object.keys(sdkModule).join(', '));
      }

      console.log('Using TpaServer constructor:', TpaServerConstructor.name || 'Anonymous');

      this.tpaServer = new TpaServerConstructor({
        packageName: PACKAGE_NAME,
        apiKey: AUGMENTOS_API_KEY,
        port: PORT,
        publicDir: path.join(__dirname, 'public')
      });

      if (typeof this.tpaServer.onSession !== 'function') {
        this.tpaServer.onSession = this.onSession.bind(this);
      }

      console.log('SDK initialized successfully');
    } catch (err) {
      console.error('Failed to initialize SDK:', err);
      // Continue without SDK functionality
    }
  }

  public async shutdown(): Promise<void> {
    if (this.expressServer) {
      console.log('Initiating graceful shutdown...');
      return new Promise((resolve, reject) => {
        this.expressServer?.close((err) => {
          if (err) {
            console.error('Shutdown error:', err);
            reject(err);
            return;
          }
          console.log('Server closed successfully');
          resolve();
        });
      });
    }
    return Promise.resolve();
  }

  private setupRoutes(): void {
    const app = this.expressApp;

    app.use(express.json());
    app.use((req, res, next) => {
      this.requestCount++;
      const requestId = crypto.randomUUID();
      res.set('X-Request-ID', requestId);
      console.log(`[${new Date().toISOString()}] REQ#${this.requestCount} ${req.method} ${req.path}`);
      next();
    });

    app.get('/health', (req, res) => {
      res.status(200).json({
        status: "healthy",
        features: {
          location_fallback: ENABLE_LOCATION_FALLBACK,
          location_timeout: LOCATION_TIMEOUT_MS
        }
      });
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
      try {
        res.status(200).json({
          status: "success",
          message: "Webhook received",
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        res.status(200).json({ status: "error", message: "Webhook processing failed" });
      }
    });

    app.get('/', (req, res) => {
      res.json({
        status: "running",
        version: "1.4.0",
        endpoints: ['/health', '/tpa_config.json']
      });
    });
  }

  protected async onSession(
    session: TpaSession,
    sessionId: string,
    userId: string
  ): Promise<void> {
    console.log(`New session started: ${sessionId} for user ${userId}`);

    const locationHandler = async (update: any) => {
      const locationUpdate = update as LocationUpdate;
      const lat = locationUpdate.lat ?? locationUpdate.latitude;
      const lon = locationUpdate.lon ?? locationUpdate.longitude;

      if (lat && lon) {
        session.location = {
          latitude: lat,
          longitude: lon,
          timestamp: Date.now()
        };
        await this.handleLocationUpdate(session, lat, lon);
      }
    };

    const transcriptionHandler = async (transcript: any) => {
      const text = (transcript as { text: string }).text.toLowerCase();
      if (this.VOICE_COMMANDS.some(cmd => text.includes(cmd))) {
        try {
          const { lat, lon } = await this.getLocationWithFallback(session);
          await this.handleLocationUpdate(session, lat, lon);
        } catch (error) {
          await session.layouts.showTextWall(
            "⚠️ Couldn't determine your location",
            { view: ViewType.MAIN, durationMs: 5000 }
          );
        }
      }
    };

    session.events.on('location', locationHandler);
    session.events.on('transcription', transcriptionHandler);

    // Cleanup on session end
    const cleanup = () => {
      session.events.off?.('location', locationHandler);
      session.events.off?.('transcription', transcriptionHandler);
    };

    session.events.on('end', cleanup);
  }

  private async getLocationWithFallback(session: TpaSession): Promise<{ lat: number; lon: number }> {
    const lastLocation = await session.getLastKnownLocation();
    if (lastLocation) {
      return lastLocation;
    }

    if (session.location) {
      return {
        lat: session.location.latitude,
        lon: session.location.longitude
      };
    }

    const hasPermission = await session.hasLocationPermission();
    if (!hasPermission) {
      await session.layouts.showTextWall(
        "📍 Please enable location permissions",
        { view: ViewType.MAIN, durationMs: 5000 }
      );
    }

    try {
      const locationPromise = new Promise<{ lat: number; lon: number }>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error('Location request timed out'));
        }, LOCATION_TIMEOUT_MS);

        const handler = (update: any) => {
          clearTimeout(timeoutId);
          const coords = update as LocationUpdate;
          const lat = coords.lat ?? coords.latitude;
          const lon = coords.lon ?? coords.longitude;
          if (lat && lon) {
            resolve({ lat, lon });
          } else {
            reject(new Error('Invalid location received'));
          }
        };

        session.events.on('location', handler);
      });

      if (typeof session.requestLocation === 'function') {
        await session.requestLocation();
      }
      return await locationPromise;
    } catch (error) {
      if (!ENABLE_LOCATION_FALLBACK) {
        throw error;
      }
    }

    if (ENABLE_LOCATION_FALLBACK) {
      try {
        return await this.getIPBasedLocation();
      } catch (error) {
        console.error('IP geolocation failed:', error);
      }
    }

    return { lat: DEFAULT_LAT, lon: DEFAULT_LON };
  }

  private async getIPBasedLocation(): Promise<{ lat: number; lon: number }> {
    const options: RequestInit = {
      headers: { 'User-Agent': 'AirQualityApp/1.4.0' }
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch('https://ipapi.co/json/', {
        ...options,
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`IP geolocation failed: ${response.status}`);
      }

      const data = await response.json() as { latitude: number; longitude: number };
      if (data.latitude && data.longitude) {
        return { lat: data.latitude, lon: data.longitude };
      }
      throw new Error('No location data in IP response');
    } finally {
      clearTimeout(timeout);
    }
  }

  private async handleLocationUpdate(
    session: TpaSession,
    lat: number,
    lon: number
  ): Promise<void> {
    try {
      const station = await getNearestAQIStation(lat, lon);
      const quality = AQI_LEVELS.find(l => station.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];
      await session.layouts.showTextWall(
        `🌫️ Air Quality Index: ${station.aqi} (${quality.label})`,
        { view: ViewType.MAIN, durationMs: 6000 }
      );
    } catch (error) {
      await session.layouts.showTextWall(
        "❌ Failed to get air quality information",
        { view: ViewType.MAIN, durationMs: 5000 }
      );
    }
  }
}

// App initialization
const airQualityApp = new AirQualityApp();

// Shutdown handlers
const handleShutdown = async (signal: string) => {
  console.log(`Received ${signal}. Shutting down...`);
  await airQualityApp.shutdown();
  process.exit(0);
};

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));