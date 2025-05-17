// v1.3.4 - Fully type-correct implementation
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { TpaServer, TpaSession, ViewType } from '@augmentos/sdk';
import axios from 'axios';
import crypto from 'crypto';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const packageJson = JSON.parse(
  readFileSync(path.join(__dirname, '../package.json'), 'utf-8')
);
const APP_VERSION = packageJson.version;
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'air-quality-app';
const AUGMENTOS_API_KEY = process.env.AUGMENTOS_API_KEY as string;
const AQI_TOKEN = process.env.AQI_TOKEN as string;

if (!AUGMENTOS_API_KEY || !AQI_TOKEN) {
  console.error('❌ Missing required environment variables');
  process.exit(1);
}

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

interface LocationData {
  latitude: number;
  longitude: number;
  accuracy?: number;
  timestamp?: number;
}

// import or define WebSocketError if needed
interface WebSocketError {
  // minimal props for type compatibility
  message?: string;
  stack?: string;
  [key: string]: any;
}

class AirQualityApp extends TpaServer {
  private requestCount = 0;
  private currentLocations = new Map<string, LocationData>();

  constructor() {
    super({
      packageName: PACKAGE_NAME,
      apiKey: AUGMENTOS_API_KEY,
      port: PORT,
      publicDir: path.join(__dirname, '../public')
    });

    process.on('uncaughtException', (err) => {
      console.error('❌ Uncaught Exception:', err);
    });

    process.on('SIGINT', () => {
      console.log('\n🔌 Shutting down gracefully...');
      process.exit(0);
    });
  }

  public async start(): Promise<void> {
    await super.start();
    console.log(`\n✅ Air Quality v${APP_VERSION}`);
    console.log(`🌐 Local: http://localhost:${PORT}`);
    console.log(`📡 Ready for connections\n`);
  }

  protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    console.log(`🔌 Session started: ${sessionId} for user ${userId}`);

    // Fix here: widen error param to Error | WebSocketError
    session.events.on('error', (err: Error | WebSocketError) => {
      // Normalize err.message safely
      const msg = err && typeof err === 'object' && 'message' in err && typeof err.message === 'string'
        ? err.message
        : String(err);
      console.error(`❌ Session Error (${sessionId}):`, msg);
    });

    session.events.on('locationUpdate', (location: LocationData) => {
      this.currentLocations.set(sessionId, location);
      console.log(`📍 GPS Location updated:`, location);
      this.checkAirQuality(session, location).catch(console.error);
    });

    session.events.on('locationPermissionResponse', (granted: boolean) => {
      if (!granted) {
        console.warn('⚠️ Location permission denied');
        session.layouts.showTextWall("Enable location for accurate results", {
          view: ViewType.MAIN,
          durationMs: 3000
        });
      }
    });

    session.events.on('transcription', (transcript: { text: string; language: string }) => {
      console.log(`🎤 Raw transcript:`, transcript);
      if (transcript.language === 'en-US') {
        const text = transcript.text.toLowerCase();
        console.log(`🎤 Processed command: "${text}"`);
        const location = this.currentLocations.get(sessionId);
        this.checkAirQuality(session, location).catch(console.error);
      }
    });

    session.events.on('voiceStateChange', (state: { active: boolean }) => {
      console.log(`🎤 Microphone ${state.active ? 'active' : 'inactive'}`);
    });

    const initialLocation = this.currentLocations.get(sessionId);
    await this.checkAirQuality(session, initialLocation);
  }

  private async getNearestAQIStation(lat: number, lon: number): Promise<AQIStationData> {
    try {
      console.log(`🔍 Fetching AQI data for coordinates: ${lat}, ${lon}`);
      const response = await axios.get(
        `https://api.waqi.info/feed/geo:${lat};${lon}/?token=${AQI_TOKEN}`,
        { timeout: 5000 }
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
      console.error('❌ AQI station fetch failed:', error);
      throw error;
    }
  }

  private async checkAirQuality(session: TpaSession, location?: LocationData): Promise<void> {
    try {
      const coords = location 
        ? { lat: location.latitude, lon: location.longitude }
        : await this.getApproximateCoords();
      
      console.log(`📍 Using coordinates: ${coords.lat}, ${coords.lon}`);
      
      const station = await this.getNearestAQIStation(coords.lat, coords.lon);
      const quality = AQI_LEVELS.find(l => station.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];
      
      console.log(`💨 AQI: ${station.aqi} (${quality.label}) at ${station.station.name}`);
      
      await session.layouts.showTextWall(
        `📍 ${station.station.name}\n\n` +
        `Air Quality: ${quality.label} ${quality.emoji}\n` +
        `AQI: ${station.aqi}\n\n` +
        `${quality.advice}`,
        { view: ViewType.MAIN, durationMs: 10000 }
      );
    } catch (error) {
      console.error("❌ AQI check failed:", error);
      await session.layouts.showTextWall("Air quality unavailable", { 
        view: ViewType.MAIN,
        durationMs: 3000 
      });
    }
  }

  private async getApproximateCoords(): Promise<{ lat: number, lon: number }> {
    try {
      console.log('📱 User location not available. Attempting IP geolocation...');
      const ip = await axios.get('https://ipapi.co/json/', { timeout: 3000 });
      if (ip.data.latitude && ip.data.longitude) {
        console.log(`📍 IP geolocation success: ${ip.data.latitude}, ${ip.data.longitude}`);
        return { lat: ip.data.latitude, lon: ip.data.longitude };
      }
    } catch (error) {
      console.warn("⚠️ IP geolocation failed:", error);
    }
    const fallbackLat = parseFloat(process.env.FALLBACK_LAT || '51.5074');
    const fallbackLon = parseFloat(process.env.FALLBACK_LON || '-0.1278');
    console.log(`📍 Using fallback location: ${fallbackLat}, ${fallbackLon}`);
    return { lat: fallbackLat, lon: fallbackLon };
  }
}

console.log(`🚀 Launching Air Quality v${APP_VERSION}...`);
new AirQualityApp().start()
  .catch(err => {
    console.error('❌ Fatal startup error:', err);
    process.exit(1);
  });
