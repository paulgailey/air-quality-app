// Version 1.1 - Enhanced location handling with fallbacks
import * as dotenv from 'dotenv';
dotenv.config();
import path from 'path';
import { TpaServer, TpaSession, ViewType } from '@augmentos/sdk';
import { fileURLToPath } from 'url';
import { AQI_LEVELS, LocationUpdate } from './types/types.js';
import { getNearestAQIStation } from './services/airQualityService.js';
import express from 'express';
import crypto from 'crypto';
import fetch from 'node-fetch';

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

// Interface for TpaServerOptions
interface TpaServerOptions {
  packageName: string;
  apiKey: string;
  port: number;
  publicDir: string;
}

// Type definitions for EventManager
// Ensure this matches the original EventManager type in @augmentos/sdk
interface EventManager {
  on(event: 'location' | 'transcription', handler: (data: LocationUpdate | { text: string }) => void): void;
  off(event: 'location' | 'transcription', handler: (data: LocationUpdate | { text: string }) => void): void;
}

// Type definitions for LayoutManager
interface LayoutManager {
  showTextWall(text: string, options: { view: ViewType; durationMs: number }): Promise<void>;
}

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
    requestLocation(): Promise<void>;
    getLastKnownLocation(): Promise<{ lat: number; lon: number } | null>;
    hasLocationPermission(): Promise<boolean>;
    // Removed duplicate declaration of 'events'
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
    const options: TpaServerOptions = {
      packageName: PACKAGE_NAME,
      apiKey: AUGMENTOS_API_KEY,
      port: PORT,
      publicDir: path.join(__dirname, 'public')
    };
    super(options);

    this.setupRoutes();
    console.log(`Starting AirQualityApp on port ${PORT}`);
  }

  private setupRoutes(): void {
    const app = this.getExpressApp();
    
    app.use(express.json());
    app.use((req, res, next) => {
      this.requestCount++;
      const requestId = crypto.randomUUID();
      res.set('X-Request-ID', requestId);
      console.log(`[${new Date().toISOString()}] REQ#${this.requestCount} ${req.method} ${req.path}`);
      
      if (req.method === 'POST' && req.path === '/webhook') {
        console.log('Webhook request body:', JSON.stringify(req.body));
      }
      
      next();
    });

    app.get('/', (req, res) => {
      res.json({
        status: "running",
        version: "1.1.0",
        endpoints: ['/health', '/tpa_config.json']
      });
    });

    app.get('/health', (req, res) => {
      res.json({ 
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
    
    app.post('/webhook-debug', express.json(), (req, res) => {
      console.log('Debug webhook received:', req.body);
      res.json({ received: true, body: req.body });
    });
  }

  protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    console.log(`New session started: ${sessionId} for user ${userId}`);

    session.events.on('location', async (update: LocationUpdate) => {
      console.log('Location update received:', update);
      const lat = update.lat ?? update.latitude;
      const lon = update.lon ?? update.longitude;

      if (lat && lon) {
        console.log(`Valid location received: ${lat}, ${lon}`);
        session.location = {
          latitude: lat,
          longitude: lon,
          timestamp: Date.now()
        };
        await this.handleLocationUpdate(session, lat, lon);
      } else {
        console.warn('Invalid location data:', update);
      }
    });

    session.events.on('transcription', async (transcript: { text: string }) => {
      console.log('Transcription received:', transcript);
      const text = transcript.text.toLowerCase();
      
      if (this.VOICE_COMMANDS.some(cmd => text.includes(cmd))) {
        console.log('Voice command matched:', text);
        try {
          const { lat, lon } = await this.getLocationWithFallback(session);
          await this.handleLocationUpdate(session, lat, lon);
        } catch (error) {
          console.error('Location handling failed:', error);
          await session.layouts.showTextWall(
            "⚠️ Couldn't determine your location. Try again later.",
            { view: ViewType.MAIN, durationMs: 5000 }
          );
        }
      }
    });
  }

  private async getLocationWithFallback(session: TpaSession): Promise<{ lat: number; lon: number }> {
    // 1. Try getting last known location
    const lastLocation = await session.getLastKnownLocation();
    if (lastLocation) {
      console.log('Using last known location:', lastLocation);
      return lastLocation;
    }

    // 2. Check for existing session location
    if (session.location) {
      console.log('Using session location:', session.location);
      return {
        lat: session.location.latitude,
        lon: session.location.longitude
      };
    }

    // 3. Check permissions
    const hasPermission = await session.hasLocationPermission();
    if (!hasPermission) {
      await session.layouts.showTextWall(
        "📍 Please enable location permissions in settings",
        { view: ViewType.MAIN, durationMs: 5000 }
      );
    }

    // 4. Request fresh location with timeout
    try {
      console.log('Requesting fresh location...');
      const locationPromise = new Promise<{ lat: number; lon: number }>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error('Location request timed out'));
        }, LOCATION_TIMEOUT_MS);

        const handler = (update: unknown) => {
          clearTimeout(timeoutId);
          // Using a type assertion to ensure TypeScript understands this is a valid object
          const eventManager = session.events as unknown as { off(event: string, handler: Function): void };
          eventManager.off('location', handler);
          const coords = update as LocationUpdate;
          const lat = coords.lat ?? coords.latitude;
          const lon = coords.lon ?? coords.longitude;
          if (lat && lon) {
            resolve({ lat, lon });
          } else {
            reject(new Error('Invalid location received'));
          }
        };

        session.events.on('location', handler as (data: LocationUpdate) => void);
      });

      if (session.requestLocation) {
        await session.requestLocation();
      } else {
        throw new Error('requestLocation is not available on the session object');
      }
      return await locationPromise;
    } catch (error) {
      console.error('Location request failed:', error);
      if (!ENABLE_LOCATION_FALLBACK) throw error;
    }

    // 5. Fallback to IP geolocation
    if (ENABLE_LOCATION_FALLBACK) {
      console.log('Attempting IP-based fallback location');
      try {
        const ipLocation = await this.getIPBasedLocation();
        console.log('Using IP-based location:', ipLocation);
        return ipLocation;
      } catch (error) {
        console.error('IP geolocation failed:', error);
      }
    }

    // 6. Final fallback to defaults
    console.log(`Using default location: ${DEFAULT_LAT},${DEFAULT_LON}`);
    return { lat: DEFAULT_LAT, lon: DEFAULT_LON };
  }

  private async getIPBasedLocation(): Promise<{ lat: number; lon: number }> {
    const options = {
      headers: { 'User-Agent': 'AirQualityApp/1.1' },
      timeout: 2000
    };
    
    const response = await fetch('https://ipapi.co/json/', options);
    
    if (!response.ok) {
      throw new Error(`IP geolocation failed: ${response.status}`);
    }
    
    const data = (await response.json()) as { latitude: number; longitude: number };
    if (data.latitude && data.longitude) {
      return { lat: data.latitude, lon: data.longitude };
    }
    throw new Error('No location data in IP response');
  }

  private async handleLocationUpdate(session: TpaSession, lat: number, lon: number): Promise<void> {
    try {
      console.log(`Processing AQI data for location: ${lat}, ${lon}`);
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
  console.log(`✅ Server v1.1 running on port ${PORT}`);
});
