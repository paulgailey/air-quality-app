import '@augmentos/sdk';

declare module '@augmentos/sdk' {
  interface TpaSession {
    location?: {
      latitude: number;
      longitude: number;
      timestamp: number;
    };
    lastLocationUpdate?: number;
    requestLocation?(): Promise<void>;
  }
}
