// Version 2.0.6 - Full implementation with all type fixes
import 'dotenv/config';
import express, { Request, Response, NextFunction, Application } from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { TpaServer, TpaSession, ViewType } from '@augmentos/sdk';
import axios from 'axios';
import crypto from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { ParsedQs } from 'qs';

// Configuration
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(path.join(__dirname, '../package.json'), 'utf-8')
);
const config = JSON.parse(readFileSync(path.join(__dirname, '../config.json'), 'utf-8'));
const APP_VERSION = "2.0.6";
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const AUGMENTOS_API_KEY = process.env.AUGMENTOS_API_KEY as string;
const AQI_TOKEN = process.env.AQI_TOKEN as string;

// Validate environment
if (!AUGMENTOS_API_KEY || !AQI_TOKEN) {
  console.error('❌ Missing required environment variables');
  process.exit(1);
}

// AQI Levels from waqi.info
const AQI_LEVELS = [
  { max: 50, label: "Good", emoji: "😊", advice: "Perfect for outdoor activities!" },
  { max: 100, label: "Moderate", emoji: "😐", advice: "Acceptable air quality" },
  { max: 150, label: "Unhealthy for Sensitive Groups", emoji: "😷", advice: "Reduce prolonged exertion" },
  { max: 200, label: "Unhealthy", emoji: "😨", advice: "Wear a mask outdoors" },
  { max: 300, label: "Very Unhealthy", emoji: "⚠️", advice: "Limit outdoor exposure" },
  { max: Infinity, label: "Hazardous", emoji: "☢️", advice: "Stay indoors with windows closed" }
];

// Configuration for TPA SDK
interface TpaServerConfig {
  packageName: string;
  apiKey: string;
  port: number;
  publicDir: string;
  websocketUrl?: string;
}

interface AQIStationData {
  aqi: number;
  station: {
    name: string;
    geo: [number, number];
  };
}

declare module '@augmentos/sdk' {
  interface TpaSession {
    audio?: {
      play(path: string): Promise<void>;
      speak?(text: string, options?: { language?: string }): Promise<void>;
    };
    onLocation: (
      listener: (update: {
        coords: {
          latitude: number;
          longitude: number;
          accuracy: number;
          altitude: number | null;
          altitudeAccuracy: number | null;
          heading: number | null;
          speed: number | null;
        };
        timestamp: number;
      }) => void
    ) => void;
  }
}

// Define a type for the specific layout method we need
interface TextWallLayout {
  showTextWall(text: string, options: { view: ViewType; durationMs: number }): Promise<void>;
}

class AirQualityApp extends TpaServer {
  private _activeSessions = new Map<string, { userId: string; started: Date }>();
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
      packageName: "air-quality-app",
      apiKey: AUGMENTOS_API_KEY,
      port: PORT,
      publicDir: path.join(__dirname, '../public')
    } as any);
    
    // Store websocket URL in environment for webhook handler to use later
    if (process.env.AUGMENTOS_WEBSOCKET_URL) {
      console.log(`Using WebSocket URL: ${process.env.AUGMENTOS_WEBSOCKET_URL}`);
    }
    
    // Add more detailed logging for debugging
    console.log(`Initializing Air Quality app v${APP_VERSION}`);
    console.log(`Package name: air-quality-app`);
    console.log(`Public directory: ${path.join(__dirname, '../public')}`);
    console.log(`API key length: ${AUGMENTOS_API_KEY?.length || 0} characters`);
    console.log(`WebSocket URL: ${process.env.AUGMENTOS_WEBSOCKET_URL || 'Using default'}`);
    
    this.setupRoutes();
    
    // Register error handler for uncaught exceptions
    process.on('uncaughtException', (error) => {
      console.error('Uncaught exception:', error);
    });
  }

  private setupRoutes(): void {
    const app = this.getExpressApp() as Application;

    app.get('/favicon.ico', (req: Request<{}, any, any, ParsedQs, Record<string, any>>, res: Response<any, Record<string, any>>) => {
      res.status(204).end();
    });

    app.use((req: Request, res: Response, next: NextFunction) => {
      res.setHeader('ngrok-skip-browser-warning', 'true');
      next();
    });

    app.use((req: Request, res: Response, next: NextFunction) => {
      this.requestCount++;
      const requestId = crypto.randomUUID();
      res.set('X-Request-ID', requestId);
      console.log(`[${new Date().toISOString()}] REQ#${this.requestCount} ${req.method} ${req.path}`);
      next();
    });

    app.use(express.json());

    app.get('/', (req: Request, res: Response) => {
      res.json({
        status: "running",
        version: APP_VERSION,
        endpoints: ['/health', '/tpa_config.json']
      });
    });

    app.get('/health', (req: Request, res: Response) => {
      res.json({
        status: "healthy",
        sessions: this._activeSessions.size
      });
    });

    app.get('/tpa_config.json', (req: Request, res: Response) => {
      res.json({
        voiceCommands: this.VOICE_COMMANDS.map(phrase => ({
          phrase,
          description: "Check air quality"
        })),
        permissions: ["location", "audio"],
        transcriptionLanguages: ["en-US"]
      });
    });

    app.post('/webhook', async (req: Request, res: Response) => {
      if (req.body?.type === 'session_request') {
        try {
          console.log(`Received session request for ${req.body.sessionId}`);
          console.log(`WebSocket URL: ${req.body.augmentOSWebsocketUrl || 'Not provided'}`);
          
          // Store the websocket URL if provided
          if (req.body.augmentOSWebsocketUrl) {
            process.env.AUGMENTOS_WEBSOCKET_URL = req.body.augmentOSWebsocketUrl;
          }
          
          await this.handleNewSession(req.body.sessionId, req.body.userId);
          res.json({ status: 'success' });
        } catch (error) {
          console.error('Session init failed:', error);
          res.status(500).json({ status: 'error', message: 'Session initialization failed' });
        }
      } else {
        console.log('Unknown webhook request:', req.body);
        res.status(400).json({ status: 'error', message: 'Invalid webhook request' });
      }
    });
  }

  private async handleNewSession(sessionId: string, userId: string): Promise<void> {
    console.log(`Initializing new session: ${sessionId} for user ${userId}`);
    
    // The TpaServer will automatically handle session registration when the webhook receives a request
    // Just log the session info and continue
    console.log(`Session ${sessionId} initialization complete`);
  }

  protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    this._activeSessions.set(sessionId, { userId, started: new Date() });

    let currentLocation: { lat: number; lon: number } | null = null;
    let locationTimeout: NodeJS.Timeout;

    session.onLocation((update) => {
      console.log(`📍 Location updated: ${update.coords.latitude}, ${update.coords.longitude}`);
      currentLocation = {
        lat: update.coords.latitude,
        lon: update.coords.longitude
      };
      clearTimeout(locationTimeout);
    });

    locationTimeout = setTimeout(async () => {
      if (!currentLocation) {
        console.warn('Location not received, falling back to IP geolocation');
        currentLocation = await this.getApproximateCoords();
        await this.checkAirQuality(session, currentLocation);
      }
    }, 5000);

    session.onTranscriptionForLanguage('en-US', (transcript) => {
      const text = transcript.text.toLowerCase();
      console.log(`🎤 Heard: "${text}"`);
      if (this.VOICE_COMMANDS.some(cmd => text.includes(cmd.toLowerCase()))) {
        this.checkAirQuality(session, currentLocation).catch(console.error);
      }
    });

    await this.checkAirQuality(session, currentLocation);
  }

  private async checkAirQuality(
    session: TpaSession,
    coords?: { lat: number; lon: number } | null
  ): Promise<void> {
    try {
      const finalCoords = coords || await this.getApproximateCoords();
      
      const station = await this.getNearestAQIStation(finalCoords.lat, finalCoords.lon);
      const quality = AQI_LEVELS.find(l => station.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];
      
      // Type assertion to access the showTextWall method
      const layouts = session.layouts as unknown as TextWallLayout;
      await layouts.showTextWall(
        `📍 ${station.station.name}\n\n` +
        `Air Quality: ${quality.label} ${quality.emoji}\n` +
        `AQI: ${station.aqi}\n\n` +
        `${quality.advice}`,
        { view: ViewType.MAIN, durationMs: 10000 }
      );

      const audioBasePath = path.join(__dirname, '../public/audio/blip');
      const aqiLevel = quality.label.toLowerCase().split(' ')[0];
      const audioFiles = [
        path.join(audioBasePath, `${aqiLevel}.mp3`),
        path.join(audioBasePath, 'default.mp3')
      ];

      if (session.audio?.play) {
        for (const audioFile of audioFiles) {
          if (existsSync(audioFile)) {
            try {
              await session.audio.play(audioFile);
              console.log('Played audio:', path.basename(audioFile));
              break;
            } catch (audioError) {
              console.error('Audio playback failed:', audioError);
            }
          }
        }
      }
    } catch (error) {
      console.error("Check failed:", error);
      // Type assertion to access the showTextWall method
      const layouts = session.layouts as unknown as TextWallLayout;
      await layouts.showTextWall("Air quality unavailable", { 
        view: ViewType.MAIN,
        durationMs: 3000 
      });
    }
  }

  private async getNearestAQIStation(lat: number, lon: number): Promise<AQIStationData> {
    try {
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
          name: response.data.data.city?.name || 'Nearest AQI station',
          geo: response.data.data.city?.geo || [lat, lon]
        }
      };
    } catch (error) {
      console.error('AQI station fetch failed:', error);
      throw error;
    }
  }

  private async getApproximateCoords(): Promise<{ lat: number, lon: number }> {
    try {
      const ip = await axios.get('https://ipapi.co/json/', { timeout: 2000 });
      if (ip.data.latitude && ip.data.longitude) {
        return { lat: ip.data.latitude, lon: ip.data.longitude };
      }
    } catch (error) {
      console.warn("IP geolocation failed - using config default:", error);
    }
    return config.defaultLocation;
  }
}

// Server Startup
new AirQualityApp().getExpressApp().listen(PORT, () => {
  console.log(`✅ Air Quality v${APP_VERSION} running on port ${PORT}`);
  console.log(`Configure ngrok with: ngrok http ${PORT}`);
});