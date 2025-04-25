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
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'com.everywoah.airquality';
const AUGMENTOS_API_KEY = process.env.AUGMENTOS_API_KEY;
const AQI_TOKEN = process.env.AQI_TOKEN;
const NGROK_DEBUG = process.env.NGROK_DEBUG === 'true';

// Validate critical environment variables
if (!AUGMENTOS_API_KEY || !AQI_TOKEN) {
  console.error('❌ Missing required environment variables');
  console.error(`AUGMENTOS_API_KEY: ${AUGMENTOS_API_KEY ? '***' : 'MISSING'}`);
  console.error(`AQI_TOKEN: ${AQI_TOKEN ? '***' : 'MISSING'}`);
  process.exit(1);
}

// Air Quality Index Levels
const AQI_LEVELS = [
  { max: 50, label: "Good", emoji: "😊", advice: "Perfect for outdoor activities!" },
  { max: 100, label: "Moderate", emoji: "😐", advice: "Acceptable air quality" },
  { max: 150, label: "Unhealthy for Sensitive Groups", emoji: "😷", advice: "Reduce prolonged exertion" },
  { max: 200, label: "Unhealthy", emoji: "😨", advice: "Wear a mask outdoors" },
  { max: 300, label: "Very Unhealthy", emoji: "⚠️", advice: "Limit outdoor exposure" },
  { max: Infinity, label: "Hazardous", emoji: "☢️", advice: "Stay indoors with windows closed" }
];

interface SessionData {
  sessionId: string;
  userId: string;
  type: string;
}

interface AQIData {
  aqi: number;
  city: {
    name: string;
    geo: [number, number];
    url: string;
  };
}

class AirQualityApp extends TpaServer {
  private requestCount = 0;
  private activeSessions = new Map<string, { userId: string; started: Date }>();
  private voiceCommands = [
    "air quality", 
    "what's the air like",
    "pollution",
    "air pollution",
    "is the air clean",
    "is the air dirty",
    "how clean is the air"
  ];

  constructor() {
    super({
      packageName: PACKAGE_NAME,
      apiKey: AUGMENTOS_API_KEY,
      port: PORT,
      publicDir: path.join(__dirname, '../public'),
    });
    
    this.setupRoutes();
    this.addDebugRoutes(); // New debug endpoint
  }

  private addDebugRoutes(): void {
    const expressApp = this.getExpressApp();
    
    // Debug endpoint to verify Express is working
    expressApp.get('/debug-express', (req, res) => {
      console.log('✅ Debug endpoint hit');
      res.json({ 
        status: 'Express is responding',
        timestamp: new Date().toISOString()
      });
    });
  }

  private setupRoutes(): void {
    const expressApp = this.getExpressApp();

    // Health check endpoint
    expressApp.get('/health', (req, res) => res.json({ 
      status: "healthy",
      uptime: process.uptime(),
      activeSessions: this.activeSessions.size
    }));

    // ... [rest of your existing route setup code remains identical]
  }

  // ... [all your existing methods remain unchanged]
}

// Initialize with enhanced debugging
try {
  const server = new AirQualityApp();
  
  // Direct access to Express instance for debugging
  const expressInstance = server.getExpressApp();
  
  // Add explicit error handling
  expressInstance.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server confirmed listening on http://0.0.0.0:${PORT}`);
    console.log(`🔍 Debug endpoints:
    http://localhost:${PORT}/health
    http://localhost:${PORT}/debug-express`);
  }).on('error', (err) => {
    console.error('❌ Server failed to start:', err);
    process.exit(1);
  });

  process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
  });
} catch (err) {
  console.error('❌ Startup failed:', err);
  process.exit(1);
}