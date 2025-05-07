import 'dotenv/config';
import path from 'path';
import { TpaServer, TpaSession, ViewType } from '@augmentos/sdk';
import { fileURLToPath } from 'url';
import { AQI_LEVELS } from './types/types.js';
import { getNearestAQIStation } from './services/airQualityService.js';

// ---- Correct module augmentation ----
declare module '@augmentos/sdk' {
  interface TpaSession {
    id: string;
    location?: {
      latitude: number;
      longitude: number;
      timestamp: number;
    };
    lastLocationUpdate?: number;
    requestLocation?(): Promise<void>;
  }

  interface TpaSessionEvents {
    location: { lat: number; lon: number };
    transcription: { text: string; language?: string };
  }

  interface LayoutManager {
    showTextWall(text: string, options: { view: ViewType; durationMs: number }): Promise<void>;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);
const AUGMENTOS_API_KEY = process.env.AUGMENTOS_API_KEY || '';
const AQI_TOKEN = process.env.AQI_TOKEN || '';

if (!AUGMENTOS_API_KEY || !AQI_TOKEN) {
  console.error('❌ Missing required environment variables');
  process.exit(1);
}

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
      publicDir: path.join(__dirname, '../public'),
    });

    console.log(`Starting AirQualityApp on port ${PORT}`);

    this.use((req: { headers: Record<string, string> }, _res: unknown, next: () => void) => {
      console.log('Request headers:', {
        forwardedFor: req.headers['x-forwarded-for'],
        realIp: req.headers['x-real-ip'],
      });
      next();
    });
  }

  protected async onSession(session: TpaSession, sessionId: string, _userId: string): Promise<void> {
    console.log(`New session started: ${sessionId}`);

    session.events.on('location', async (coords) => {
      try {
        const lat = coords.lat;
        const lon = coords.lon;

        if (lat == null || lon == null) {
          throw new Error('Invalid coordinates received');
        }

        console.log(`📍 Using coordinates: ${lat}, ${lon}`);

        session.location = {
          latitude: lat,
          longitude: lon,
          timestamp: Date.now(),
        };
        session.lastLocationUpdate = Date.now();

        const station = await getNearestAQIStation(lat, lon);
        const quality = AQI_LEVELS.find((l) => station.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];

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

    session.events.on('transcription', async ({ text }) => {
      const input = text.toLowerCase();
      console.log(`Voice transcript: "${input}"`);

      if (this.VOICE_COMMANDS.some((cmd) => input.includes(cmd))) {
        console.log('Air quality voice command detected');

        await session.layouts.showTextWall(
          '🔍 Checking air quality...',
          { view: ViewType.MAIN, durationMs: 2000 }
        );

        if (session.location?.latitude && session.location?.longitude) {
          session.events.emit('location', {
            lat: session.location.latitude,
            lon: session.location.longitude,
          });
        } else {
          await session.layouts.showTextWall(
            '📍 Waiting for your location...\nPlease ensure location services are enabled.',
            { view: ViewType.MAIN, durationMs: 3000 }
          );

          try {
            if (typeof session.requestLocation === 'function') {
              await session.requestLocation();
            }
          } catch (error) {
            console.error('Location request failed:', error);
          }
        }
      }

      if (input.includes('debug location') || input.includes('where am i')) {
        const locationMessage = session.location
          ? `📍 Your current location:\n${session.location.latitude.toFixed(6)}, ${session.location.longitude.toFixed(6)}`
          : '📍 No location data available';

        await session.layouts.showTextWall(
          `${locationMessage}\n\nSay "air quality" to check pollution levels`,
          { view: ViewType.MAIN, durationMs: 5000 }
        );
      }
    });
  }

  public async start(): Promise<void> {
    return new Promise((resolve) => {
      super.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        resolve();
      });
    });
  }
}

export const app = new AirQualityApp();
app.start().catch(console.error);
