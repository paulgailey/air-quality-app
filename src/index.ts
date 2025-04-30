import 'dotenv/config';
import path from 'path';
import { TpaServer, TpaSession, ViewType } from '@augmentos/sdk';
import { fileURLToPath } from 'url';
import { AQI_LEVELS, LocationUpdate } from './types/types';
import { getNearestAQIStation } from './services/airQualityService';

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
  ];

  constructor() {
    super({
      packageName: 'air-quality-app',
      apiKey: AUGMENTOS_API_KEY,
      port: PORT,
      publicDir: path.join(__dirname, '../public')
    });
  }

  protected async onSession(session: TpaSession & { location?: LocationUpdate }): Promise<void> {
    // Location Handler
    session.events.onLocation(async (update: unknown) => {
      try {
        const location = update as LocationUpdate;
        if (!location?.latitude || !location?.longitude) {
          throw new Error('Invalid coordinates received');
        }

        session.location = location;
        const station = await getNearestAQIStation(location.latitude, location.longitude);
        const quality = AQI_LEVELS.find(l => station.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];

        await session.layouts.showTextWall(
          `📍 ${station.station.name}\n\n` +
          `Air Quality: ${quality.label} ${quality.emoji}\n` +
          `AQI: ${station.aqi}\n\n` +
          `${quality.advice}`,
          { view: ViewType.MAIN, durationMs: 10000 }
        );
      } catch (error) {
        console.error('Location processing error:', error);
        await session.layouts.showTextWall(
          "⚠️ Couldn't determine air quality. Please try again.",
          { view: ViewType.MAIN, durationMs: 4000 }
        );
      }
    });

    // Voice Command Handler
    session.onTranscriptionForLanguage('en-US', async (transcript) => {
      const text = transcript.text.toLowerCase();
      if (this.VOICE_COMMANDS.some(cmd => text.includes(cmd.toLowerCase()))) {
        if (!session.location) {
          await session.layouts.showTextWall(
            "📍 Waiting for your location...",
            { view: ViewType.MAIN, durationMs: 2000 }
          );
          return;
        }
        
        // Trigger location handler with current location
        session.events.emit('location', session.location as any);
      }
    });
  }
}

new AirQualityApp().start();