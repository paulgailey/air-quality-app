import '@augmentos/sdk';

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
    events: {
      onLocation: (callback: (update: unknown) => void) => void;
      onTranscription: (callback: (transcript: { text: string; language?: string }) => void) => void;
      emit: (event: string, data: unknown) => void;
    };
    layouts: {
      showTextWall: (text: string, options: { view: ViewType; durationMs: number }) => Promise<void>;
    };
  }
}