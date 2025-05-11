// src/types/augmentos.d.ts
import { LocationUpdate } from './types';
declare module '@augmentos/sdk' {
  interface TpaSession {
    id: string;
    location?: { latitude: number; longitude: number };
    lastLocationUpdate?: number;
    requestLocation?: () => Promise<void>;
  }

  // Enhanced version with emit()
  interface SessionEvents {
    onLocation(listener: (update: LocationUpdate) => void): void;
    emit(event: 'location', update: LocationUpdate): void;  // <-- New addition
  }
}