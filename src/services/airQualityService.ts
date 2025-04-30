import { AQIStationData } from '../types/types';

const WAQI_API_KEY = process.env.AQI_TOKEN || '';
const WAQI_API_URL = 'https://api.waqi.info/feed/geo:';

export async function getNearestAQIStation(latitude: number, longitude: number): Promise<AQIStationData> {
  if (!WAQI_API_KEY) throw new Error('WAQI API token not configured');

  const response = await fetch(`${WAQI_API_URL}${latitude};${longitude}/?token=${WAQI_API_KEY}`);
  
  if (!response.ok) throw new Error(`WAQI API error: ${response.statusText}`);

  const data = await response.json();

  if (data.status !== 'ok' || typeof data.data?.aqi !== 'number') {
    throw new Error('Invalid WAQI API response');
  }

  // Strict type handling for geo coordinates
  let geo: [number, number];
  if (Array.isArray(data.data.city?.geo)) {
    geo = [
      Number(data.data.city.geo[0]) || latitude,
      Number(data.data.city.geo[1]) || longitude
    ];
  } else {
    geo = [latitude, longitude];
  }

  return {
    aqi: data.data.aqi,
    station: {
      name: data.data.city?.name || 'Unknown Station',
      geo: geo,
      distance: 0
    }
  };
}