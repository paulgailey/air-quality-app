import 'dotenv/config';
import path from 'path';
import { TpaServer, TpaSession, ViewType } from '@augmentos/sdk';
import { fileURLToPath } from 'url';
import { AQI_LEVELS, LocationUpdate } from './types/types.js';
import { getNearestAQIStation } from './services/airQualityService';

// Fix module resolution
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);
const AUGMENTOS_API_KEY = process.env.AUGMENTOS_API_KEY || '';
const AQI_TOKEN = process.env.AQI_TOKEN || '';

if (!AUGMENTOS_API_KEY || !AQI_TOKEN) {
  console.error('❌ Missing required environment variables');
  process.exit(1);
}

// Extended session interface with all required properties
interface AugmentedSession extends TpaSession {
  id: string;
  location?: {
    latitude: number;
    longitude: number;
    timestamp: number;
  };
  lastLocationUpdate?: number;
  events: {
    onLocation: (callback: (update: unknown) => void) => void;
    onTranscription: (callback: (transcript: { text: string; language?: string }) => void) => void;
    emit: (event: string, data: unknown) => void;
  };
  layouts: {
    showTextWall: (text: string, options: { view: ViewType; durationMs: number }) => Promise<void>;
  };
  requestLocation?: () => Promise<void>;
}

// Properly typed AirQualityApp class
class AirQualityApp extends TpaServer {
  private readonly VOICE_COMMANDS = [
    "what's the air quality like",
    "air quality",
    "how's the air",
    "pollution level",
    "is the air safe"
  ] as const;

  constructor() {
    super({
      packageName: 'air-quality-app',
      apiKey: AUGMENTOS_API_KEY,
      port: PORT,
      publicDir: path.join(__dirname, '../public')
    });

    console.log(`Starting AirQualityApp on port ${PORT}`);
    
    // Add middleware with proper typing
    this.addMiddleware((req: { headers: Record<string, string> }, res: unknown, next: () => void) => {
      const headers = req.headers;
      console.log('Request headers:', {
        forwardedFor: headers['x-forwarded-for'],
        realIp: headers['x-real-ip']
      });
      next();
    });
  }

  protected async onSession(session: AugmentedSession): Promise<void> {
    console.log(`New session started: ${session.id}`);

    // Location Handler
    session.events.onLocation(async (update: unknown) => {
      try {
        const coords = update as LocationUpdate;
        const lat = coords.lat ?? coords.latitude;
        const lon = coords.lon ?? coords.longitude;

        if (lat === undefined || lon === undefined) {
          throw new Error('Invalid coordinates received');
        }

        console.log(`📍 Using coordinates: ${lat}, ${lon}`);

        // Store location in session
        session.location = {
          latitude: lat,
          longitude: lon,
          timestamp: Date.now()
        };
        session.lastLocationUpdate = Date.now();

        // Get air quality data
        const station = await getNearestAQIStation(lat, lon);
        const quality = AQI_LEVELS.find(l => station.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];

        // Show result
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
          "⚠️ Couldn't determine air quality.\nPlease try again in a moment.",
          { view: ViewType.MAIN, durationMs: 4000 }
        );
      }
    });

    // Voice Command Handler
    session.events.onTranscription(async (transcript) => {
      const text = transcript.text.toLowerCase();
      console.log(`Voice transcript: "${text}"`);

      if (this.VOICE_COMMANDS.some(cmd => text.includes(cmd.toLowerCase()))) {
        console.log('Air quality voice command detected');

        await session.layouts.showTextWall(
          "🔍 Checking air quality...",
          { view: ViewType.MAIN, durationMs: 2000 }
        );

        if (session.location?.latitude && session.location?.longitude) {
          session.events.emit('location', {
            lat: session.location.latitude,
            lon: session.location.longitude
          });
        } else {
          await session.layouts.showTextWall(
            "📍 Waiting for your location...\nPlease ensure location services are enabled.",
            { view: ViewType.MAIN, durationMs: 3000 }
          );

          try {
            if (session.requestLocation) {
              await session.requestLocation();
            }
          } catch (error) {
            console.error('Location request failed:', error);
          }
        }
      }

      // Debug command
      if (text.includes('debug location') || text.includes('where am i')) {
        const locationMessage = session.location
          ? `📍 Your current location:\n${session.location.latitude.toFixed(6)}, ${session.location.longitude.toFixed(6)}`
          : "📍 No location data available";

        await session.layouts.showTextWall(
          `${locationMessage}\n\nSay "air quality" to check pollution levels`,
          { view: ViewType.MAIN, durationMs: 5000 }
        );
      }
    });
  }

  // Add start method
  public start(): void {
    this.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  }
}

// Start the app
const app = new AirQualityApp();
app.start();