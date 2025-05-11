// AQI Types (Retain only if used elsewhere in your project)
export interface AQILevel {
  max: number;
  label: string;
  emoji: string;
  advice: string;
}

export interface AQIStationData {
  aqi: number;
  station: {
    name: string;
    geo: [number, number];
    distance?: number;
  };
}

export const AQI_LEVELS: AQILevel[] = [
  { max: 50, label: "Good", emoji: "😊", advice: "Perfect for outdoor activities!" },
  { max: 100, label: "Moderate", emoji: "😐", advice: "Unusually sensitive people should reduce exertion" },
  { max: 150, label: "Unhealthy for Sensitive", emoji: "😷", advice: "Sensitive groups should limit outdoor exertion" },
  { max: 200, label: "Unhealthy", emoji: "😨", advice: "Everyone should limit outdoor exertion" },
  { max: 300, label: "Very Unhealthy", emoji: "🤢", advice: "Avoid outdoor activities" },
  { max: 500, label: "Hazardous", emoji: "☠️", advice: "Stay indoors with windows closed" }
];

// Align with AugmentOS SDK's LocationUpdate (https://docs.augmentos.org/reference/interfaces/event-types#locationupdate)
export interface LocationUpdate {
  latitude: number;  // Required by SDK
  longitude: number; // Required by SDK
  accuracy?: number; // Optional
  timestamp?: number; // Optional
}

// Module Augmentation (Fixed to match SDK types)
declare module '@augmentos/sdk' {
  interface TpaSession {
    id: string;
    location?: { latitude: number; longitude: number }; // SDK expects this shape
    lastLocationUpdate?: number;
    requestLocation?: () => Promise<void>;
  }

  interface SessionEvents {
    onLocation(listener: (update: LocationUpdate) => void | Promise<void>): void;
    emit(event: 'location', update: LocationUpdate): void;
  }

  interface TpaServer {
    use?: (middleware: (req: any, res: any, next: any) => void) => void;
  }
}