import 'dotenv/config';
import path from 'path';
import { TpaServer, TpaSession, ViewType } from '@augmentos/sdk';
import { fileURLToPath } from 'url';
import { AQI_LEVELS, LocationUpdate } from './types/types';
import { getNearestAQIStation } from './services/airQualityService';
// Update this import line at the top of index.ts


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
    
    console.log(`Starting AirQualityApp on port ${PORT}`);
    
    if (this.use) {
      this.use((req: any, res: any, next: any) => {
        if (req?.headers) {
          if (req.headers['x-forwarded-for']) {
            console.log('X-Forwarded-For header:', req.headers['x-forwarded-for']);
          }
          if (req.headers['x-real-ip']) {
            console.log('X-Real-IP header:', req.headers['x-real-ip']);
          }
        }
        next?.();
      });
    }
  }

  protected async onSession(session: TpaSession): Promise<void> {
    console.log(`New session started: ${session.id}`);
    
    // Location Handler - handles both coordinate formats
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
    session.onTranscriptionForLanguage('en-US', async (transcript) => {
      const text = transcript.text.toLowerCase();
      console.log(`Voice transcript: "${text}"`);
      
      if (this.VOICE_COMMANDS.some(cmd => text.includes(cmd.toLowerCase()))) {
        console.log('Air quality voice command detected');
        
        // Show loading message
        await session.layouts.showTextWall(
          "🔍 Checking air quality...",
          { view: ViewType.MAIN, durationMs: 2000 }
        );
        
        // If we have location stored in the session
        if (session.location?.latitude && session.location?.longitude) {
          // Force location event with stored coordinates
          (session.events as any).emit('location', {
            lat: session.location.latitude,
            lon: session.location.longitude
          });
        } else {
          // No location yet, show waiting message
          await session.layouts.showTextWall(
            "📍 Waiting for your location...\nPlease ensure location services are enabled.",
            { view: ViewType.MAIN, durationMs: 3000 }
          );
          
          // Try to request location from device if API available
          try {
            if (typeof session.requestLocation === 'function') {
              await session.requestLocation();
              console.log('Location request sent to client');
            }
          } catch (error) {
            console.error('Error requesting location:', error);
          }
        }
      }
      
      // Debug command
      if (text.includes('debug location') || text.includes('where am i')) {
        if (session.location?.latitude && session.location?.longitude) {
          await session.layouts.showTextWall(
            `📍 Your location is being tracked.\n\n` +
            `Coordinates: ${session.location.latitude.toFixed(6)}, ${session.location.longitude.toFixed(6)}\n` +
            `Say "air quality" to check pollution levels`,
            { view: ViewType.MAIN, durationMs: 5000 }
          );
        } else {
          await session.layouts.showTextWall(
            "📍 No location data available yet.\n\n" +
            "Say \"air quality\" to trigger location request.",
            { view: ViewType.MAIN, durationMs: 4000 }
          );
        }
      }
    });
  }
}

// Start the app
const app = new AirQualityApp();
app.start();