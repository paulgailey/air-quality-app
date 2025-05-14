// Version 1.3.5 - Fixed fetch timeout issue and improved TypeScript compatibility
import * as dotenv from 'dotenv';
dotenv.config();
import path from 'path';
import { TpaServer, ViewType } from '@augmentos/sdk';
import { fileURLToPath } from 'url';
import { AQI_LEVELS } from './types/types.js';
import { getNearestAQIStation } from './services/airQualityService.js';
import express from 'express';
import crypto from 'crypto';
import { default as fetch } from 'node-fetch';
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
class AirQualityApp extends TpaServer {
    expressServer;
    VOICE_COMMANDS = [
        "what's the air quality like",
        "air quality",
        "how's the air",
        "pollution level",
        "is the air safe"
    ];
    requestCount = 0;
    constructor() {
        super({
            packageName: PACKAGE_NAME,
            apiKey: AUGMENTOS_API_KEY,
            port: PORT,
            publicDir: path.join(__dirname, 'public')
        });
        const expressApp = this.getExpressApp();
        this.expressServer = expressApp.listen(PORT, '0.0.0.0', () => {
            console.log(`Server running on http://0.0.0.0:${PORT}`);
        });
        this.setupRoutes();
        console.log(`Starting AirQualityApp on port ${PORT}`);
    }
    async shutdown() {
        if (this.expressServer) {
            console.log('Initiating graceful shutdown...');
            return new Promise((resolve, reject) => {
                this.expressServer?.close((err) => {
                    if (err) {
                        console.error('Shutdown error:', err);
                        reject(err);
                        return;
                    }
                    console.log('Server closed successfully');
                    resolve();
                });
            });
        }
        return Promise.resolve();
    }
    setupRoutes() {
        const app = this.getExpressApp();
        app.use(express.json());
        app.use((req, res, next) => {
            this.requestCount++;
            const requestId = crypto.randomUUID();
            res.set('X-Request-ID', requestId);
            console.log(`[${new Date().toISOString()}] REQ#${this.requestCount} ${req.method} ${req.path}`);
            next();
        });
        app.get('/health', (req, res) => {
            res.status(200).json({
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
        app.post('/webhook', async (req, res) => {
            try {
                res.status(200).json({
                    status: "success",
                    message: "Webhook received",
                    timestamp: new Date().toISOString()
                });
            }
            catch (error) {
                res.status(200).json({ status: "error", message: "Webhook processing failed" });
            }
        });
        app.get('/', (req, res) => {
            res.json({
                status: "running",
                version: "1.3.5",
                endpoints: ['/health', '/tpa_config.json']
            });
        });
    }
    async onSession(session, sessionId, userId) {
        console.log(`New session started: ${sessionId} for user ${userId}`);
        const locationHandler = async (update) => {
            const locationUpdate = update;
            const lat = locationUpdate.lat ?? locationUpdate.latitude;
            const lon = locationUpdate.lon ?? locationUpdate.longitude;
            if (lat && lon) {
                session.location = {
                    latitude: lat,
                    longitude: lon,
                    timestamp: Date.now()
                };
                await this.handleLocationUpdate(session, lat, lon);
            }
        };
        const transcriptionHandler = async (transcript) => {
            const text = transcript.text.toLowerCase();
            if (this.VOICE_COMMANDS.some(cmd => text.includes(cmd))) {
                try {
                    const { lat, lon } = await this.getLocationWithFallback(session);
                    await this.handleLocationUpdate(session, lat, lon);
                }
                catch (error) {
                    await session.layouts.showTextWall("⚠️ Couldn't determine your location", { view: ViewType.MAIN, durationMs: 5000 });
                }
            }
        };
        session.events.on('location', locationHandler);
        session.events.on('transcription', transcriptionHandler);
    }
    async getLocationWithFallback(session) {
        const lastLocation = await session.getLastKnownLocation();
        if (lastLocation) {
            return lastLocation;
        }
        if (session.location) {
            return {
                lat: session.location.latitude,
                lon: session.location.longitude
            };
        }
        const hasPermission = await session.hasLocationPermission();
        if (!hasPermission) {
            await session.layouts.showTextWall("📍 Please enable location permissions", { view: ViewType.MAIN, durationMs: 5000 });
        }
        try {
            const locationPromise = new Promise((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    reject(new Error('Location request timed out'));
                }, LOCATION_TIMEOUT_MS);
                const handler = (update) => {
                    clearTimeout(timeoutId);
                    const coords = update;
                    const lat = coords.lat ?? coords.latitude;
                    const lon = coords.lon ?? coords.longitude;
                    if (lat && lon) {
                        resolve({ lat, lon });
                    }
                    else {
                        reject(new Error('Invalid location received'));
                    }
                };
                session.events.on('location', handler);
            });
            if (typeof session.requestLocation === 'function') {
                await session.requestLocation();
            }
            return await locationPromise;
        }
        catch (error) {
            if (!ENABLE_LOCATION_FALLBACK) {
                throw error;
            }
        }
        if (ENABLE_LOCATION_FALLBACK) {
            try {
                return await this.getIPBasedLocation();
            }
            catch (error) {
                console.error('IP geolocation failed:', error);
            }
        }
        return { lat: DEFAULT_LAT, lon: DEFAULT_LON };
    }
    async getIPBasedLocation() {
        const options = {
            headers: { 'User-Agent': 'AirQualityApp/1.3.5' }
        };
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        try {
            const response = await fetch('https://ipapi.co/json/', {
                ...options,
                signal: controller.signal
            });
            if (!response.ok) {
                throw new Error(`IP geolocation failed: ${response.status}`);
            }
            const data = await response.json();
            if (data.latitude && data.longitude) {
                return { lat: data.latitude, lon: data.longitude };
            }
            throw new Error('No location data in IP response');
        }
        finally {
            clearTimeout(timeout);
        }
    }
    async handleLocationUpdate(session, lat, lon) {
        try {
            const station = await getNearestAQIStation(lat, lon);
            const quality = AQI_LEVELS.find(l => station.aqi <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];
            await session.layouts.showTextWall(`🌫️ Air Quality Index: ${station.aqi} (${quality.label})`, { view: ViewType.MAIN, durationMs: 6000 });
        }
        catch (error) {
            await session.layouts.showTextWall("❌ Failed to get air quality information", { view: ViewType.MAIN, durationMs: 5000 });
        }
    }
}
// App initialization
const airQualityApp = new AirQualityApp();
// Shutdown handlers
const handleShutdown = async (signal) => {
    console.log(`Received ${signal}. Shutting down...`);
    await airQualityApp.shutdown();
    process.exit(0);
};
process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
