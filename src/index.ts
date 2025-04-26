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

interface AQIStationData {
  aqi: number;
  station: {
    name: string;
    geo: [number, number];
  };
}

interface LocationQueryResult {
  cityName: string;
  coordinates: { lat: number, lon: number };
  success: boolean;
  message?: string;
}

class AirQualityApp extends TpaServer {
  private activeSessions = new Map<string, { userId: string; started: Date }>();
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
        endpoints: ['/health', '/tpa_config.json']
      });
    });

    app.get('/health', (req, res) => {
      res.json({
        status: "healthy",
        sessions: this.activeSessions.size
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

    session.onTranscriptionForLanguage('en-US', (transcript) => {
      const text = transcript.text.toLowerCase();
      console.log(`🎤 Heard: "${text}"`);
      
      // Check if user is asking about a specific location
      const locationQuery = this.extractLocationQuery(text);
      
      if (locationQuery) {
        console.log(`📍 Location query detected: "${locationQuery}"`);
        this.checkAirQualityForLocation(session, locationQuery).catch(console.error);
      } else if (this.VOICE_COMMANDS.some(cmd => text.includes(cmd.toLowerCase()))) {
        // If no specific location is mentioned, use current location
        this.checkAirQuality(session).catch(console.error);
      }
    });

    // Initial greeting
    await this.checkAirQuality(session);
  }

  private extractLocationQuery(text: string): string | null {
    // Match patterns like "in [location]", "at [location]", "for [location]"
    const locationPatterns = [
      /(?:what's|what is|how's|how is)(?:.*)(?:air|pollution|quality)(?:.*)(?:in|at|for) ([\w\s]+)(?:\?|$)/i,
      /(?:air|pollution|quality)(?:.*)(?:in|at|for) ([\w\s]+)(?:\?|$)/i
    ];

    for (const pattern of locationPatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
    
    return null;
  }

  private async geocodeLocation(locationName: string): Promise<LocationQueryResult> {
    try {
      // Use a geocoding API to convert location name to coordinates
      const response = await axios.get(
        `https://api.opencagedata.com/geocode/v1/json?q=${encodeURIComponent(locationName)}&key=${process.env.GEOCODING_API_KEY || 'd4b514a833144f3dbd9e5c0515fd92cf'}`,
        { timeout: 3000 }
      );
      
      if (response.data.results && response.data.results.length > 0) {
        const result = response.data.results[0];
        return {
          cityName: result.formatted,
          coordinates: { 
            lat: result.geometry.lat, 
            lon: result.geometry.lng 
          },
          success: true
        };
      } else {
        return {
          cityName: locationName,
          coordinates: { lat: 0, lon: 0 },
          success: false,
          message: "Location not found"
        };
      }
    } catch (error) {
      console.error('Geocoding failed:', error);
      return {
        cityName: locationName,
        coordinates: { lat: 0, lon: 0 },
        success: false,
        message: "Geocoding service error"
      };
    }
  }

  private async checkAirQualityForLocation(session: TpaSession, locationQuery: string): Promise<void> {
    try {
      // Get coordinates for the queried location
      const locationResult = await this.geocodeLocation(locationQuery);
      
      if (!locationResult.success) {
        await session.layouts.showTextWall(
          `Sorry, I couldn't find air quality data for "${locationQuery}"\n\n${locationResult.message || "Location not recognized"}`,
          { view: ViewType.MAIN, durationMs: 5000 }
        );
        return;
      }
      
      // Get AQI data for the location
      const station = await this.getNearestAQIStation(
        locationResult.coordinates.lat, 
        locationResult.coordinates.lon
      );
      
      const quality = AQI_LEVELS.find(l => station.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];
      
      await session.layouts.showTextWall(
        `📍 ${locationResult.cityName}\n` +
        `Station: ${station.station.name}\n\n` +
        `Air Quality: ${quality.label} ${quality.emoji}\n` +
        `AQI: ${station.aqi}\n\n` +
        `${quality.advice}`,
        { view: ViewType.MAIN, durationMs: 10000 }
      );
    } catch (error) {
      console.error("Location check failed:", error);
      await session.layouts.showTextWall(
        `Air quality data for "${locationQuery}" is unavailable.\nPlease try another location.`, 
        { view: ViewType.MAIN, durationMs: 5000 }
      );
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

  private async checkAirQuality(session: TpaSession): Promise<void> {
    try {
      const coords = session.location?.latitude 
        ? { lat: session.location.latitude, lon: session.location.longitude }
        : await this.getApproximateCoords();
      
      const station = await this.getNearestAQIStation(coords.lat, coords.lon);
      const quality = AQI_LEVELS.find(l => station.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];
      
      await session.layouts.showTextWall(
        `📍 ${station.station.name}\n\n` +
        `Air Quality: ${quality.label} ${quality.emoji}\n` +
        `AQI: ${station.aqi}\n\n` +
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

  private async getApproximateCoords(): Promise<{ lat: number, lon: number }> {
    try {
      const ip = await axios.get('https://ipapi.co/json/', { timeout: 2000 });
      if (ip.data.latitude && ip.data.longitude) {
        return { lat: ip.data.latitude, lon: ip.data.longitude };
      }
    } catch (error) {
      console.warn("IP geolocation failed:", error);
    }
    return { lat: 51.5074, lon: -0.1278 }; // London fallback
  }
}

// Server Startup
new AirQualityApp().getExpressApp().listen(PORT, () => {
  console.log(`✅ Air Quality v${APP_VERSION} running on port ${PORT}`);
});