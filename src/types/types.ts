export interface LocationUpdate {
  lat?: number;
  lon?: number;
  latitude?: number;
  longitude?: number;
}

export interface AQILevel {
  max: number;
  label: string;
  emoji: string;
  advice: string;
}

export const AQI_LEVELS: AQILevel[] = [
  { max: 50, label: "Good", emoji: "😊", advice: "Perfect for outdoor activities!" },
  { max: 100, label: "Moderate", emoji: "😐", advice: "Acceptable air quality" },
  { max: 150, label: "Unhealthy for Sensitive Groups", emoji: "😷", advice: "Reduce prolonged exertion" },
  { max: 200, label: "Unhealthy", emoji: "😨", advice: "Wear a mask outdoors" },
  { max: 300, label: "Very Unhealthy", emoji: "⚠️", advice: "Limit outdoor exposure" },
  { max: Infinity, label: "Hazardous", emoji: "☢️", advice: "Stay indoors with windows closed" }
];

export interface AQIStation {
  aqi: number;
  station: {
    name: string;
    geo: [number, number];
  };
  getLatestAQI: () => number;
}
