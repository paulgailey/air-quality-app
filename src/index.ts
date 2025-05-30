// air-quality-app/src/index.ts - VERSION 4.2.3 - CONFIGURABLE ENVIRONMENTS
import "dotenv/config";
import express, { Application, Request, Response, NextFunction } from "express";
import { fileURLToPath } from "url";
import path from "path";
import { TpaServer, TpaSession, ViewType } from "@augmentos/sdk";
import axios, { AxiosError } from "axios";
import { readFileSync } from "fs";

// ======================
// CONFIGURATION LOADER
// ======================
const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface AppConfig {
  environment: string;
  api: {
    baseUrl: string;
    timeout: number;
    useNgrok: boolean;
  };
  debug: {
    verboseLogs: boolean;
  };
}

const env = process.env.NODE_ENV || "dev";
let config: AppConfig;

try {
  const configPath = path.join(__dirname, `../config.${env}.json`);
  config = JSON.parse(readFileSync(configPath, "utf-8")) as AppConfig;
  console.log(`✅ Loaded ${env} configuration`);
} catch (err) {
  console.error(`❌ Failed to load config.${env}.json:`, err);
  process.exit(1);
}

// ======================
// TYPE DECLARATIONS
// ======================
interface AQIStation {
  aqi: number;
  station: {
    name: string;
    geo: [number, number];
  };
}

interface SessionLocation {
  lat: number;
  lon: number;
  timestamp: number;
}

interface SessionData {
  userId: string;
  location?: SessionLocation;
  lastAQI?: {
    data: AQIStation;
    timestamp: number;
  };
}

interface AQILevel {
  max: number;
  label: string;
  emoji: string;
  advice: string;
}

interface TpaConfig {
  voiceCommands: Array<{ phrase: string; description: string }>;
  defaultLocation: { lat: number; lon: number };
}

// ======================
// CONSTANTS
// ======================
const tpaConfig: TpaConfig = JSON.parse(
  readFileSync(path.join(__dirname, "../public/tpa_config.json"), "utf-8")
);

const PORT = parseInt(process.env.PORT || "3000", 10);
const AUGMENTOS_API_KEY = process.env.AUGMENTOS_API_KEY || "";
const AQI_TOKEN = process.env.AQI_TOKEN || "";
const LOCATION_MAX_AGE_MS = 30000;
const AQI_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const RECENT_REQUEST_THRESHOLD_MS = 2 * 60 * 1000;
const API_TIMEOUT_MS = config.api.timeout || 8000;
const TRANSCRIPTION_FEEDBACK_MS = 3000;

if (!AUGMENTOS_API_KEY || !AQI_TOKEN) {
  console.error("❌ Missing required environment variables");
  process.exit(1);
}

const AQI_LEVELS: AQILevel[] = [
  {
    max: 50,
    label: "Good",
    emoji: "😊",
    advice: "Perfect for outdoor activities!",
  },
  {
    max: 100,
    label: "Moderate",
    emoji: "😐",
    advice: "Acceptable air quality",
  },
  {
    max: 150,
    label: "Unhealthy for Sensitive Groups",
    emoji: "😷",
    advice: "Reduce prolonged exertion",
  },
  { max: 200, label: "Unhealthy", emoji: "😨", advice: "Wear a mask outdoors" },
  {
    max: 300,
    label: "Very Unhealthy",
    emoji: "⚠️",
    advice: "Limit outdoor exposure",
  },
  {
    max: Infinity,
    label: "Hazardous",
    emoji: "☢️",
    advice: "Stay indoors with windows closed",
  },
];

// =================
// MAIN APPLICATION
// =================
class AirQualityApp extends TpaServer {
  private sessions = new Map<string, SessionData>();
  private readonly VOICE_COMMAND =
    tpaConfig.voiceCommands[0].phrase.toLowerCase();
  public expressApp: Application;

  constructor() {
    super({
      packageName: "air-quality-app",
      apiKey: AUGMENTOS_API_KEY,
      port: PORT,
      publicDir: path.join(__dirname, "../public"),
    });

    this.expressApp = super.getExpressApp() as Application;
    this.setupServer();
  }

  private setupServer(): void {
    this.expressApp.use((req: Request, res: Response, next: NextFunction) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("ngrok-skip-browser-warning", "true");
      res.setHeader("X-Response-Time", "1s");
      next();
    });

    this.expressApp.use(express.json());

    this.expressApp.get("/", (req: Request, res: Response) => {
      res.json({
        status: "running",
        version: "4.2.3",
        endpoints: ["/health"],
      });
    });

    this.expressApp.get("/health", (req: Request, res: Response) => {
      res.json({
        status: "healthy",
        sessions: this.sessions.size,
        uptime: process.uptime(),
      });
    });

    this.expressApp.post("/webhook", async (req: Request, res: Response) => {
      try {
        if (req.body?.type === "session_request") {
          await this.handleNewSession(req.body.sessionId, req.body.userId);
          return res.json({ status: "success" });
        }
        res.status(400).json({ status: "invalid_request" });
      } catch (error) {
        console.error("Webhook error:", error);
        res.status(500).json({ status: "error" });
      }
    });

    this.expressApp.use((req: Request, res: Response) => {
      res.status(404).json({ error: "Endpoint not found" });
    });
  }

  private async handleNewSession(
    sessionId: string,
    userId: string
  ): Promise<void> {
    console.log(`🆕 New session: ${sessionId} for user ${userId}`);
    this.sessions.set(sessionId, { userId });
  }

  protected async onSession(
    session: TpaSession,
    sessionId: string,
    userId: string
  ): Promise<void> {
    const sessionData: SessionData = { userId };
    this.sessions.set(sessionId, sessionData);

    session.events.onTranscription(async (data: any) => {
      try {
        if (!data?.text) {
          console.warn("Empty transcription received");
          await session.layouts.showTextWall("❌ No speech detected", {
            view: ViewType.MAIN,
            durationMs: 2000,
          });
          return;
        }

        const text = data.text.toLowerCase().trim();
        console.log(`🗣️ RAW INPUT: "${text}"`);

        await session.layouts.showTextWall(`Processing: "${text}"`, {
          view: ViewType.MAIN,
          durationMs: TRANSCRIPTION_FEEDBACK_MS,
        });

        if (data.isFinal) {
          if (text.includes(this.VOICE_COMMAND)) {
            console.log("✅ Valid command detected");
            await this.handleAirQualityRequest(session, sessionId);
          } else {
            console.warn("⚠️ Unrecognized command");
            await session.layouts.showTextWall('Try saying "air quality"', {
              view: ViewType.MAIN,
              durationMs: 3000,
            });
          }
        }
      } catch (error) {
        console.error("Transcription handler error:", error);
      }
    });

    session.events.onLocation((location: any) => {
      try {
        if (!location?.lat || !location?.lng) {
          console.warn("Invalid location received");
          return;
        }

        console.log(`📍 Location update: ${location.lat}, ${location.lng}`);
        sessionData.location = {
          lat: location.lat,
          lon: location.lng,
          timestamp: Date.now(),
        };
      } catch (error) {
        console.error("Location handler error:", error);
      }
    });

    await session.layouts.showTextWall(
      `Say "${this.VOICE_COMMAND}" for air quality`,
      { view: ViewType.MAIN, durationMs: 4000 }
    );
  }

  private async handleAirQualityRequest(
    session: TpaSession,
    sessionId: string
  ): Promise<void> {
    const now = Date.now();
    const sessionData = this.sessions.get(sessionId);
    if (!sessionData) return;

    try {
      const coords = this.getCurrentCoordinates(sessionData, now);
      const isDefaultLocation =
        !sessionData.location ||
        now - sessionData.location.timestamp > LOCATION_MAX_AGE_MS;

      if (sessionData.lastAQI) {
        const ageMs = now - sessionData.lastAQI.timestamp;

        if (ageMs <= RECENT_REQUEST_THRESHOLD_MS) {
          await this.showResult(
            session,
            sessionData.lastAQI.data,
            `Same as ${Math.floor(ageMs / 1000)}s ago`,
            isDefaultLocation
          );
          return;
        }

        if (ageMs <= AQI_REFRESH_INTERVAL_MS) {
          await this.showResult(
            session,
            sessionData.lastAQI.data,
            `${Math.floor(ageMs / 60000)}m old data`,
            isDefaultLocation
          );
          return;
        }
      }

      await session.layouts.showTextWall(
        isDefaultLocation
          ? "⚠️ Using default location..."
          : "📍 Checking your location...",
        { view: ViewType.MAIN, durationMs: 2000 }
      );

      const station = await this.fetchAQIData(coords.lat, coords.lon);
      sessionData.lastAQI = { data: station, timestamp: now };
      await this.showResult(
        session,
        station,
        "Current air quality",
        isDefaultLocation
      );
    } catch (error) {
      console.error("Request failed:", error);
      await session.layouts.showTextWall("⚠️ Service unavailable", {
        view: ViewType.MAIN,
        durationMs: 3000,
      });
    }
  }

  private getCurrentCoordinates(
    sessionData: SessionData,
    currentTime: number
  ): { lat: number; lon: number } {
    if (
      sessionData.location &&
      currentTime - sessionData.location.timestamp <= LOCATION_MAX_AGE_MS
    ) {
      return sessionData.location;
    }
    return tpaConfig.defaultLocation;
  }

  private async fetchAQIData(lat: number, lon: number): Promise<AQIStation> {
    console.log(`🌐 Fetching AQI for ${lat}, ${lon}`);

    const response = await axios.get(
      `https://api.waqi.info/feed/geo:${lat};${lon}/?token=${AQI_TOKEN}`,
      {
        timeout: API_TIMEOUT_MS,
      }
    );

    if (response.data.status !== "ok" || !response.data.data?.aqi) {
      throw new Error("Invalid API response");
    }

    return {
      aqi: response.data.data.aqi,
      station: {
        name: response.data.data.city?.name || "Nearest Station",
        geo: response.data.data.city?.geo || [lat, lon],
      },
    };
  }

  private async showResult(
    session: TpaSession,
    data: AQIStation,
    freshness: string,
    isDefaultLocation: boolean
  ): Promise<void> {
    const quality = this.getQualityLevel(data.aqi);
    const locationNote = isDefaultLocation ? "\n⚠️ Using default location" : "";

    await session.layouts.showTextWall(
      `${freshness}${locationNote}\n` +
        `📍 ${data.station.name}\n` +
        `Air Quality: ${quality.label} ${quality.emoji}\n` +
        `AQI: ${data.aqi}\n\n` +
        `${quality.advice}`,
      { view: ViewType.MAIN, durationMs: 10000 }
    );
  }

  private getQualityLevel(aqi: number): AQILevel {
    return (
      AQI_LEVELS.find((l) => aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1]
    );
  }
}

// =============
// SERVER START
// =============
console.log(`🚀 Starting Air Quality App v4.2.3`);

const app = new AirQualityApp();
const server = app.expressApp.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`🔧 Debug mode: ${config.debug.verboseLogs ? "ON" : "OFF"}`);
});

process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down...");
  server.close(() => process.exit(0));
});
