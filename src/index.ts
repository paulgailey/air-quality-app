// Version 1.3.2 - Fixed TypeScript compatibility with Augmentos SDK
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

// Type definitions for TpaSession extensions
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
      publicDir: path.join(__dirname, 'public')
    });

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
        version: "1.3.2",
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

  protected async onSession(session: TpaSession & {
    events: {
      on(event: string, handler: (data: any) => void): void;
      off?(event: string, handler: (data: any) => void): void;
    };
    layouts: {
      showTextWall(text: string, options: { view: ViewType; durationMs: number }): Promise<void>;
    };
  }, sessionId: string, userId: string): Promise<void> {
    console.log(`New session started: ${sessionId} for user ${userId}`);

    const locationHandler = async (update: any) => {
      const locationUpdate = update as LocationUpdate;
      console.log('Location update received:', locationUpdate);
      const lat = locationUpdate.lat ?? locationUpdate.latitude;
      const lon = locationUpdate.lon ?? locationUpdate.longitude;

      if (lat && lon) {
        console.log(`Valid location received: ${lat}, ${lon}`);
        session.location = {
          latitude: lat,
          longitude: lon,
          timestamp: Date.now()
        };
        await this.handleLocationUpdate(session, lat, lon);
      } else {
        console.warn('Invalid location data:', locationUpdate);
      }
    };

    const transcriptionHandler = async (transcript: any) => {
      const textData = transcript as { text: string };
      console.log('Transcription received:', textData);
      const text = textData.text.toLowerCase();
      
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
    };

    session.events.on('location', locationHandler);
    session.events.on('transcription', transcriptionHandler);
  }

  private async getLocationWithFallback(session: TpaSession & {
    events: {
      on(event: string, handler: (data: any) => void): void;
      off?(event: string, handler: (data: any) => void): void;
    };
  }): Promise<{ lat: number; lon: number }> {
    const lastLocation = await session.getLastKnownLocation();
    if (lastLocation) {
      console.log('Using last known location:', lastLocation);
      return lastLocation;
    }

    if (session.location) {
      console.log('Using session location:', session.location);
      return {
        lat: session.location.latitude,
        lon: session.location.longitude
      };
    }

    const hasPermission = await session.hasLocationPermission();
    if (!hasPermission) {
      await session.layouts.showTextWall(
        "📍 Please enable location permissions in settings",
        { view: ViewType.MAIN, durationMs: 5000 }
      );
    }

    try {
      console.log('Requesting fresh location...');
      const locationPromise = new Promise<{ lat: number; lon: number }>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error('Location request timed out'));
        }, LOCATION_TIMEOUT_MS);
    
        const handler = (update: any) => {
          clearTimeout(timeoutId);
          
          // Safe event unsubscription
          try {
            if (typeof (session.events as any).off === 'function') {
              (session.events as any).off('location', handler);
            } else if (typeof (session.events as any).removeListener === 'function') {
              (session.events as any).removeListener('location', handler);
            }
          } catch (e) {
            console.warn('Failed to remove location event listener:', e);
          }
          
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
      console.error('Location request failed:', error);
      if (!ENABLE_LOCATION_FALLBACK) throw error;
    }

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

    console.log(`Using default location: ${DEFAULT_LAT},${DEFAULT_LON}`);
    return { lat: DEFAULT_LAT, lon: DEFAULT_LON };
  }

  private async getIPBasedLocation(): Promise<{ lat: number; lon: number }> {
    const options = {
      headers: { 'User-Agent': 'AirQualityApp/1.3.2' },
      timeout: 2000
    };

    const response = await fetch('https://ipapi.co/json/', options as any);

    if (!response.ok) {
      throw new Error(`IP geolocation failed: ${response.status}`);
    }

    const data = await response.json() as { latitude: number; longitude: number };
    if (data.latitude && data.longitude) {
      return { lat: data.latitude, lon: data.longitude };
    }
    throw new Error('No location data in IP response');
  }

  private async handleLocationUpdate(session: TpaSession & {
    layouts: {
      showTextWall(text: string, options: { view: ViewType; durationMs: number }): Promise<void>;
    };
  }, lat: number, lon: number): Promise<void> {
    try {
      console.log(`Processing AQI data for location: ${lat}, ${lon}`);
      const station = await getNearestAQIStation(lat, lon);
      console.log('AQI station data:', station);

      const quality = AQI_LEVELS.find(l => station.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];

      await session.layouts.showTextWall(
        `🌫️ Air Quality Index: ${station.aqi} (${quality.label})`,
        { view: ViewType.MAIN, durationMs: 6000 }
      );
    } catch (error) {
      console.error('Failed to fetch or display AQI data:', error);
      await session.layouts.showTextWall(
        "❌ Failed to get air quality information.",
        { view: ViewType.MAIN, durationMs: 5000 }
      );
    }
  }
}

new AirQualityApp();