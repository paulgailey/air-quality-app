// types.d.ts
declare module '@augmentos/sdk' {
  export interface EventManager {
    onTranscription(callback: (data: TranscriptionData) => void): () => void;
    onLocation(callback: (data: LocationUpdate) => void): () => void;
    onEnd(callback: () => void): () => void;
  }

  export interface TranscriptionData {
    text: string;
    language: string;
    isFinal: boolean;
  }

  export interface LocationUpdate {
    lat: number;
    lng: number;
    accuracy?: number;
    timestamp?: number;
  }

  export interface TpaSession {
    events: EventManager;
    layouts: {
      showTextWall(
        text: string,
        options: { view: ViewType; durationMs: number }
      ): Promise<void>;
    };
  }

  export class TpaServer {
    constructor(config: {
      packageName: string;
      apiKey: string;
      port: number;
      publicDir: string;
    });
    
    protected getExpressApp(): any;
    protected onSession(session: TpaSession, sessionId: string, userId: string): Promise<void>;
  }

  export enum ViewType {
    MAIN = 'main',
    IMMERSIVE = 'immersive',
    COMPACT = 'compact',
    FULLSCREEN = 'fullscreen'
  }
}