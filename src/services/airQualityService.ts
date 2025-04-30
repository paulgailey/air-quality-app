import { AQIStationData } from '../types/types';

const WAQI_API_KEY = process.env.AQI_TOKEN || '';
const WAQI_API_URL = 'https://api.waqi.info/feed/geo:';

export async function getNearestAQIStation(latitude: number, longitude: number): Promise<AQIStationData> {
  if (!WAQI_API_KEY) throw new Error('WAQI API token not configured');

  const response = await fetch(`${WAQI_API_URL}${latitude};${longitude}/?token=${WAQI_API_KEY}`);
  
  if (!response.ok) throw new Error(`WAQI API error: ${response.statusText}`);

  const data = await response.json();

  if (data.status !== 'ok' || !data.data?.aqi) {
    throw new Error('Invalid WAQI API response');
  }

  return {
    aqi: data.data.aqi,
    station: {
      name: data.data.city?.name || 'Unknown Station',
      geo: [data.data.city?.geo || [latitude, longitude]],
      distance: 0
    }
  };
}