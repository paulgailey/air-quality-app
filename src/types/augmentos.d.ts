// Remove the import and define LocationUpdate directly
interface LocationUpdate {
  coords: {
    latitude: number;
    longitude: number;
  };
}

declare module '@augmentos/sdk' {
  interface TpaSession {
    id: string;
    location?: { latitude: number; longitude: number };
    lastLocationUpdate?: number;
    requestLocation?: () => Promise<void>;
  }

  interface SessionEvents {
    onLocation(listener: (update: LocationUpdate) => void): void;
    emit(event: 'location', update: LocationUpdate): void;
  }
}